/**
 * **集計表の宣言(`report_view`)が受け付ける形と、受け付けない形の実測**
 * (`V8-M8`。台帳 `Q-G1` / `Q-G4` / `Q-G15` / `Q-G21c` / `Q-G22` / `Q-G35` / `Q-G36`。
 * ユーザ決定 `D-V8-5` / `D-V8-120` / `D-V8-122`)。
 *
 * **審査の正は `docs/plan/v8/records/v8-m7.md`(v8 の2本目の軸 = 集計表とグラフ の門A 本審査)**、
 * 完了条件の正は `V8-M8` の実装ブリーフ §4 である。
 *
 * ## ここで測るもの(**本物の SQLite / 本物の HTTP**)
 *
 * | 群 | 何を |
 * |---|---|
 * | (A) | **適用時の拒否**(`src/kernel/referential-integrity.ts`)。**本物の SQLite への適用で示す** |
 * | (B) | **スキーマの値域**(`schemas/manifest.schema.json`)。**同じく本物の適用で示す** |
 * | (C) | **計算**(`GET /api/apps/:app_id/views/:view_id/report` の応答) |
 * | (D) | **白箱**(製品コードの文字列を読む。`list-view-sum-boundary.test.ts` の (D) と同じ形) |
 *
 * ## 【正直に書く】この検査が言わないこと
 *
 * 1. **可視性を1ミリも測っていない** —— **`V8-M8` は集計に可視性を掛けない。**
 *    **掛けるのは `V8-M10` である。** **(28) はそのことを固定しており、`V8-M10` で
 *    反転する検査である**(テスト名にそう書いてある)。
 * 2. **上限(件数の頭打ち)を1つも測っていない** —— **実装が1バイトも無いからである**
 *    (`V8-M10`)。**群が何万件でも全部返る。**
 * 3. **ブラウザを1枚も開いていない** —— **`report_view` を描く実装は今日1バイトも無い**
 *    (描くのは `V8-M11`)。**画面としては白紙である。**
 * 4. **MCP 経路を1ミリも測っていない** —— **`list_records` は本宣言を1つも見ない**
 *    (`ADR-0104` §限界8 と同型の穴が、集計表にもそのまま在る)。
 * 5. **性能を1度も測っていない。** **集計は JS のメモリ上で行うので、母集団が大きいほど
 *    遅くなるはずだが、どこで遅くなるかは1件も測っていない。**
 * 6. **時差(タイムゾーン)を1度も測っていない** —— **日付の丸めは ISO 8601 文字列の
 *    先頭10文字をそのまま暦日として読む。** **時差の変換を1度もしない。**
 *
 * ## 【2026-08-16 訂正(`V8-M13-T04`。台帳 `Q-G30`)。上の6点を1バイトも書き換えていない】
 *
 * **上の 1 / 2 / 3 / 4 の将来形は、今日はもう将来ではない。** **このファイルが何を測って
 * いないかは1ミリも変わっていないが、「まだ無い」と書いた実装は在る。**
 *
 * - **1 と 2**: **`V8-M10` が可視性と上限を掛けた** —— **集計の母集団には、その要求をした人が
 *   読める行だけが入るので、見る人によって数が変わる。** **本ファイルの (28) は反転して
 *   いない** —— **(28) が固定しているのは「`src/kernel/report.ts` が判定を1つも持たない」
 *   ことであり、判定は今日もそのファイルの外(`src/server/app.ts`)に在るからである。**
 *   **【禁止】これを「集計に権限が効くようになった」と書かない** —— **島が `output_table` へ
 *   書いた表には1ミリも掛からず、受信口・ワークフロー・`schedule` は今日も素通りである。**
 * - **3**: **`V8-M11` が描いた** —— **集計表はブラウザに描かれ、`V8-M12` が画面の上に
 *   グラフ(棒と折れ線の2種)を足した。** **ブラウザを開く検査は `web/test/report-view.test.tsx`。**
 * - **4**: **`V8-M13-T02` が `read_report` を足した** —— **MCP からは集計表を1枚読める**
 *   (**`list_records` は今日も `report` を1つも見ない**ので、そこの穴は塞がっていない)。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { SYSTEM_TABLES } from "../shared/system-tables.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "report-boundary";

type Any = Record<string, unknown>;

/** 束ねるキー1本 + 集計2本の、素直な集計表の宣言。**多くの検査がこれを土台に1点だけ崩す。** */
const BASE_REPORT: Any = {
  group_by: [{ field: "category" }],
  aggregates: [{ type: "sum", field: "amount" }, { type: "count" }],
};

/**
 * **題材の表**。
 *
 * - `sale` —— 集計の母集団。**束ねられる4型(`select` / `reference` / `boolean` / `date`)と、
 *   束ねられない5型(`text` / `long_text` / `number` / `image` / `file`)を全部持つ。**
 * - `customer` —— `sale.customer`(`reference`)の参照先。
 *
 * **`cost` は役割の規則(`app.roles[].rules` の `target: "field"`)が名指しする項目である**
 * —— **`Q-G22`(名指しされた項目は束ねる側にも集計する側にも書けない)の当たり先。**
 */
function tables(): Any[] {
  return [
    {
      id: "sale",
      name: "売上",
      fields: [
        { id: "title", name: "件名", type: "text", required: true },
        { id: "amount", name: "金額", type: "number" },
        { id: "cost", name: "原価", type: "number" },
        { id: "category", name: "区分", type: "select", options: ["A", "B", "C"] },
        { id: "sold_at", name: "売れた日", type: "date" },
        { id: "flag", name: "確定", type: "boolean" },
        { id: "customer", name: "顧客", type: "reference", reference_table: "customer" },
        { id: "memo", name: "備考", type: "long_text" },
        { id: "photo", name: "写真", type: "image" },
        { id: "doc", name: "書類", type: "file" },
      ],
    },
    {
      id: "customer",
      name: "顧客",
      fields: [{ id: "name", name: "名前", type: "text", required: true }],
    },
  ];
}

/**
 * **既定3役割 + `sale.cost` を名指しする項目の規則。**
 *
 * **`can` に `write` も入れている理由は `list-view-sum-boundary.test.ts` と同じである** ——
 * **名指しした時点でその項目は全動詞が allow-list になるので、`read` だけ書くと
 * owner ですら `cost` を書き込めなくなる。**
 */
function roles(): Any[] {
  return [
    {
      id: "owner",
      name: "持ち主",
      rules: [{ target: "field", table: "sale", field: "cost", can: ["read", "write"] }],
    },
    { id: "editor", name: "編集者" },
    { id: "viewer", name: "閲覧者" },
  ];
}

/** 画面の集合を差し替えて題材を1つ作る(既定3役割の規則は自動で足す)。 */
function manifestOf(views: Any[], options?: { skipTables?: string[] }): Manifest {
  return withDefaultRoleRules(
    {
      app: { id: APP_ID, name: "集計表の境界", tables: tables(), views, roles: roles() },
    },
    options?.skipTables === undefined ? undefined : { skipTables: options.skipTables },
  ) as unknown as Manifest;
}

/**
 * **【`V17-M4-T01` / 台帳 `AC-G19`】画面の規則**だけ**を持つ `customer` を足した題材。**
 *
 * **本段が集計表の口に「その画面を閲覧してよいか」の判定を1本置いた。**
 * **この題材の `customer` は役割の宣言に1行も無いので、画面の関門で 403 になり、
 * 「読める行が0件の人に 200 が返る」を測れなくなる** —— **`(16)` の2人目がそれである。**
 * **`src/server/report-visibility.test.ts` のフィクスチャが `viewer` / `customer` に
 * `rules: viewRules` を持たせているのと同じ理由である**(同ファイルの逐語
 * 「**画面の規則だけは持たせる** —— **持たせないと画面の関門で 403 になり…**」)。
 *
 * **表の規則は1本も足していない** —— **足すと可視件数が0でなくなり、`(16)` が
 * 測っているもの(群ごとの件数の和 = その人の可視件数 = 0)が消える。**
 */
function manifestWithViewOnlyCustomer(): Manifest {
  const base = manifestOf(allViews()) as unknown as {
    app: { views: { id: string }[]; roles: Any[] };
  };
  base.app.roles.push({
    id: "customer",
    name: "客",
    rules: base.app.views.map((view) => ({ target: "view", view: view.id, can: ["read"] })),
  });
  return base as unknown as Manifest;
}

/**
 * **試す画面を先頭に置いた題材。**
 *
 * **`beforeEach` が適用した画面をすべて残している** —— **`applyManifest` は
 * 「マニフェストを直接渡す経路ではビューの削除を表現できない」ので、
 * 減らすと本題と無関係な理由で拒否されてしまう**(実測。2026-08-14)。
 * **先頭に置いてあるので、試す画面の JSON Pointer は必ず `/app/views/0` である。**
 */
function withViews(extra: Any[]): Manifest {
  return manifestOf([...extra, ...allViews()]);
}

/** 集計表の画面を1枚足した題材。**`report` の中身だけを差し替える。** */
function withReport(report: unknown): Manifest {
  return withViews([{ id: "r1", type: "report_view", table: "sale", report }]);
}

/** 適用してみて、拒否されたことと、拒否の場所を確かめる。 */
function rejected(manifest: Manifest): { path: string; message: string }[] {
  const result = applyManifest(dataRoot, APP_ID, manifest);
  expect(result.valid).toBe(false);
  return (result as { errors: { path: string; message: string }[] }).errors;
}

/** 適用してみて、通ったことを確かめる。 */
function accepted(manifest: Manifest): void {
  const result = applyManifest(dataRoot, APP_ID, manifest);
  expect(
    result.valid,
    result.valid ? "" : JSON.stringify((result as { errors: unknown }).errors),
  ).toBe(true);
}

/**
 * **`V8-M8` の題材の全画面。** **1つの適用に全部載せる** ——
 * **群ごとに別の題材を作ると、どの宣言が通ってどれが通らないのかが読めなくなる。**
 */
function allViews(): Any[] {
  return [
    // 一覧(`Q-G36` の当たり先。集計表を1つも宣言していない画面)。
    { id: "sale-list", type: "list_view", table: "sale", columns: ["title", "amount"] },
    // 区分ごとの合計と件数(`Q-G4` の当たり先。1つの集計表に2本)。
    { id: "by-category", type: "report_view", table: "sale", report: BASE_REPORT },
    // 束ねるキー2本(群がキーの組で作られること)。
    {
      id: "by-two",
      type: "report_view",
      table: "sale",
      report: {
        group_by: [{ field: "category" }, { field: "flag" }],
        aggregates: [{ type: "count" }],
      },
    },
    // 日付の丸め3種。
    {
      id: "by-month",
      type: "report_view",
      table: "sale",
      report: {
        group_by: [{ field: "sold_at", granularity: "month" }],
        aggregates: [{ type: "count" }],
      },
    },
    {
      id: "by-day",
      type: "report_view",
      table: "sale",
      report: {
        group_by: [{ field: "sold_at", granularity: "day" }],
        aggregates: [{ type: "count" }],
      },
    },
    {
      id: "by-week",
      type: "report_view",
      table: "sale",
      report: {
        group_by: [{ field: "sold_at", granularity: "week" }],
        aggregates: [{ type: "count" }],
      },
    },
    // 絞り込みつき。
    {
      id: "filtered",
      type: "report_view",
      table: "sale",
      report: {
        group_by: [{ field: "category" }],
        aggregates: [{ type: "count" }],
        filter: { field: "category", equals: "A" },
      },
    },
    // 深すぎる絞り込み(`MAX_FILTER_DEPTH = 8` を1段越える。根から数えて9段)。
    {
      id: "deep-filter",
      type: "report_view",
      table: "sale",
      report: {
        group_by: [{ field: "category" }],
        aggregates: [{ type: "count" }],
        filter: nestNot(9, { field: "category", equals: "A" }),
      },
    },
    /*
     * **【2026-08-15。`V8-M11-T02`。台帳 `Q-G21a` / `Q-G12`。門A 本審査 = `V8-M7`。
     * 判定 = 限定採用】並べ替え(`report.sort`)を宣言した集計表を8枚足した。**
     *
     * **8枚とも「同じ母集団を、指し方だけ変えて並べる」ためのものである** ——
     * **群のキーで指す形(`target: "group_by"`)と集計値で指す形(`target: "aggregate"`)を、
     * `asc` / `desc` の両向きで別々に打つ。**
     * **既存の8枚(`by-category` ほか)は1バイトも触っていない** ——
     * **`sort` を書かなかったときの順序が着手前と1バイトも同じであることを、
     * 同じ台の上で測るためである**(`v8-m11.md` §1-0c の決定3)。
     */
    {
      id: "sort-cat-asc",
      type: "report_view",
      table: "sale",
      report: {
        group_by: [{ field: "category" }],
        aggregates: [{ type: "sum", field: "amount" }, { type: "count" }],
        sort: { target: "group_by", index: 0, order: "asc" },
      },
    },
    {
      id: "sort-cat-desc",
      type: "report_view",
      table: "sale",
      report: {
        group_by: [{ field: "category" }],
        aggregates: [{ type: "sum", field: "amount" }, { type: "count" }],
        sort: { target: "group_by", index: 0, order: "desc" },
      },
    },
    {
      id: "sort-sum-asc",
      type: "report_view",
      table: "sale",
      report: {
        group_by: [{ field: "category" }],
        aggregates: [{ type: "sum", field: "amount" }, { type: "count" }],
        sort: { target: "aggregate", index: 0, order: "asc" },
      },
    },
    {
      id: "sort-sum-desc",
      type: "report_view",
      table: "sale",
      report: {
        group_by: [{ field: "category" }],
        aggregates: [{ type: "sum", field: "amount" }, { type: "count" }],
        sort: { target: "aggregate", index: 0, order: "desc" },
      },
    },
    {
      id: "sort-count-asc",
      type: "report_view",
      table: "sale",
      report: {
        group_by: [{ field: "category" }],
        aggregates: [{ type: "sum", field: "amount" }, { type: "count" }],
        sort: { target: "aggregate", index: 1, order: "asc" },
      },
    },
    {
      id: "sort-count-desc",
      type: "report_view",
      table: "sale",
      report: {
        group_by: [{ field: "category" }],
        aggregates: [{ type: "sum", field: "amount" }, { type: "count" }],
        sort: { target: "aggregate", index: 1, order: "desc" },
      },
    },
    // **第2キーの当たり先**(決定13)。**束ねるキーが2本で、集計値が同値の群が3つ出る台。**
    {
      id: "sort-two-count-asc",
      type: "report_view",
      table: "sale",
      report: {
        group_by: [{ field: "category" }, { field: "flag" }],
        aggregates: [{ type: "count" }],
        sort: { target: "aggregate", index: 0, order: "asc" },
      },
    },
    {
      id: "sort-two-count-desc",
      type: "report_view",
      table: "sale",
      report: {
        group_by: [{ field: "category" }, { field: "flag" }],
        aggregates: [{ type: "count" }],
        sort: { target: "aggregate", index: 0, order: "desc" },
      },
    },
  ];
}

/** `not` を `depth` 段だけ重ねる(葉の深さがそのまま `depth` になる)。 */
function nestNot(depth: number, leaf: Any): Any {
  let node: Any = leaf;
  for (let i = 0; i < depth; i += 1) {
    node = { not: node };
  }
  return node;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-report-boundary-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "集計表の境界", { app_id: APP_ID });
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

async function create(cookie: string, table: string, body: Any): Promise<void> {
  const res = await req(cookie, "POST", `/api/apps/${APP_ID}/tables/${table}/records`, body);
  expect(res.status, JSON.stringify(body)).toBe(201);
}

type ReportKey = { field: string; value: string | number | boolean | null };
type ReportAggregate = { type: string; field?: string; value: number };
type ReportBody = {
  groups: { keys: ReportKey[]; aggregates: ReportAggregate[] }[];
  total_groups: number;
  totals: ReportAggregate[];
};

/**
 * **集計表を1枚読む。**
 *
 * **【2026-08-15。`V8-M11-T03` の追記。既存の呼び出しを1件も書き換えていない】**
 * **`query` は省略できる** —— **省略したときの `URL` は着手前と1バイト同じである
 * (`?` を付けない)。** **読取時のクエリ(`sort_target` / `sort_index` / `sort_order`)を
 * 打つ検査だけが渡す。**
 */
async function readReport(
  cookie: string | undefined,
  viewId: string,
  query?: string,
): Promise<{ status: number; body: ReportBody }> {
  const suffix = query === undefined ? "" : `?${query}`;
  const res = await req(cookie, "GET", `/api/apps/${APP_ID}/views/${viewId}/report${suffix}`);
  return { status: res.status, body: (await res.json()) as ReportBody };
}

// =====================================================================================
// (A) 適用時の拒否(`src/kernel/referential-integrity.ts`)
// =====================================================================================

test("(1) 束ねるキーが実在しないフィールドを指したら、本物の SQLite で拒否される", () => {
  const errors = rejected(
    withReport({ group_by: [{ field: "nope" }], aggregates: [{ type: "count" }] }),
  );
  expect(errors.some((error) => error.path.includes("/report/group_by/0/field"))).toBe(true);
  expect(errors.some((error) => error.message.includes("存在しません"))).toBe(true);
});

test("(2) 束ねられない5型(text / long_text / number / image / file)は、5種すべて拒否される", () => {
  // **5種を別々に打つ** —— まとめて1回だけ打つと、どれか1つが通っていても気づけない。
  for (const fieldId of ["title", "memo", "amount", "photo", "doc"]) {
    const errors = rejected(
      withReport({ group_by: [{ field: fieldId }], aggregates: [{ type: "count" }] }),
    );
    expect(
      errors.some((error) => error.path === "/app/views/0/report/group_by/0/field"),
      fieldId,
    ).toBe(true);
  }
  // **束ねられる4型は通る**(閉じすぎていないことの対照)。
  for (const fieldId of ["category", "customer", "flag"]) {
    accepted(withReport({ group_by: [{ field: fieldId }], aggregates: [{ type: "count" }] }));
  }
  accepted(
    withReport({
      group_by: [{ field: "sold_at", granularity: "day" }],
      aggregates: [{ type: "count" }],
    }),
  );
});

test("(3) date を指したのに束ね方(granularity)が無ければ拒否される", () => {
  const errors = rejected(
    withReport({ group_by: [{ field: "sold_at" }], aggregates: [{ type: "count" }] }),
  );
  expect(errors.some((error) => error.path === "/app/views/0/report/group_by/0")).toBe(true);
});

test("(4) date 以外を指したのに束ね方(granularity)が有れば拒否される(書けるが効かない組み合わせを作らない)", () => {
  const errors = rejected(
    withReport({
      group_by: [{ field: "category", granularity: "month" }],
      aggregates: [{ type: "count" }],
    }),
  );
  expect(errors.some((error) => error.path === "/app/views/0/report/group_by/0/granularity")).toBe(
    true,
  );
});

test("(5) 合計(sum)は列の指定が要り、実在しない列と number 以外の列は拒否される", () => {
  // 列を書いていない。
  expect(
    rejected(withReport({ group_by: [{ field: "category" }], aggregates: [{ type: "sum" }] })).some(
      (error) => error.path === "/app/views/0/report/aggregates/0",
    ),
  ).toBe(true);
  // 実在しない列。
  expect(
    rejected(
      withReport({
        group_by: [{ field: "category" }],
        aggregates: [{ type: "sum", field: "nope" }],
      }),
    ).some((error) => error.path === "/app/views/0/report/aggregates/0/field"),
  ).toBe(true);
  // number 以外の列。
  expect(
    rejected(
      withReport({
        group_by: [{ field: "category" }],
        aggregates: [{ type: "sum", field: "title" }],
      }),
    ).some((error) => error.path === "/app/views/0/report/aggregates/0/field"),
  ).toBe(true);
});

test("(6) 件数(count)に列を書いたら拒否される", () => {
  const errors = rejected(
    withReport({
      group_by: [{ field: "category" }],
      aggregates: [{ type: "count", field: "amount" }],
    }),
  );
  expect(errors.some((error) => error.path === "/app/views/0/report/aggregates/0")).toBe(true);
});

test("(7) 役割の規則が名指しした項目は、束ねるキーにも集計する列にも書けない(Q-G22)", () => {
  expect(
    rejected(withReport({ group_by: [{ field: "cost" }], aggregates: [{ type: "count" }] })).some(
      (error) => error.message.includes("役割の規則が名指ししている項目"),
    ),
  ).toBe(true);
  expect(
    rejected(
      withReport({
        group_by: [{ field: "category" }],
        aggregates: [{ type: "sum", field: "cost" }],
      }),
    ).some((error) => error.message.includes("役割の規則が名指ししている項目")),
  ).toBe(true);
});

test("(8) 集計表の絞り込みの中の実在しない列は、一覧の filter と同じ経路で拒否される", () => {
  const errors = rejected(
    withReport({
      group_by: [{ field: "category" }],
      aggregates: [{ type: "count" }],
      filter: {
        and: [
          { field: "category", equals: "A" },
          { field: "nope", equals: 1 },
        ],
      },
    }),
  );
  // **path は既存の類型4 とまったく同じ組み立て方(`filterFieldRefs` が返す部分パス)である。**
  expect(errors.some((error) => error.path === "/app/views/0/report/filter/and/1/field")).toBe(
    true,
  );
});

test("(9) 拒否は全か無かである(通る集計表が同じ差分に在っても、1つも適用されない)", () => {
  const before = applyManifest(dataRoot, APP_ID, manifestOf(allViews()));
  expect(before.valid).toBe(true);
  const result = applyManifest(
    dataRoot,
    APP_ID,
    manifestOf([
      ...allViews(),
      { id: "ok-2", type: "report_view", table: "sale", report: BASE_REPORT },
      {
        id: "broken",
        type: "report_view",
        table: "sale",
        report: { group_by: [{ field: "nope" }], aggregates: [{ type: "count" }] },
      },
    ]),
  );
  expect(result.valid).toBe(false);
  // **通る側の画面(`ok-2`)も1枚も入っていない** —— **部分的に適用しない。**
  const manifest = JSON.parse(
    readFileSync(join(dataRoot, "apps", APP_ID, "manifest.json"), "utf-8"),
  ) as { app: { views: { id: string }[] } };
  expect(manifest.app.views.some((view) => view.id === "ok-2")).toBe(false);
  expect(manifest.app.views.some((view) => view.id === "by-category")).toBe(true);
});

// =====================================================================================
// (B) スキーマの値域(`schemas/manifest.schema.json`)
// =====================================================================================

test("(10) 集計の種類は sum / count の2値ちょうどである(avg / min / max / median は拒否)", () => {
  for (const type of ["avg", "min", "max", "median"]) {
    const errors = rejected(
      withReport({
        group_by: [{ field: "category" }],
        aggregates: [{ type, field: "amount" }],
      }),
    );
    expect(errors.length, type).toBeGreaterThan(0);
  }
});

test("(11) 束ね方は day / week / month の3値ちょうどである(year / hour / quarter は拒否)", () => {
  for (const granularity of ["year", "hour", "quarter"]) {
    const errors = rejected(
      withReport({
        group_by: [{ field: "sold_at", granularity }],
        aggregates: [{ type: "count" }],
      }),
    );
    expect(errors.length, granularity).toBeGreaterThan(0);
  }
});

test("(12) 束ねるキーも集計も、0本と4本を拒否する(1〜3本ちょうど)", () => {
  expect(
    rejected(
      withReport({
        group_by: [
          { field: "category" },
          { field: "flag" },
          { field: "customer" },
          { field: "sold_at", granularity: "day" },
        ],
        aggregates: [{ type: "count" }],
      }),
    ).length,
  ).toBeGreaterThan(0);
  expect(
    rejected(
      withReport({
        group_by: [{ field: "category" }],
        aggregates: [
          { type: "count" },
          { type: "sum", field: "amount" },
          { type: "sum", field: "amount" },
          { type: "sum", field: "amount" },
        ],
      }),
    ).length,
  ).toBeGreaterThan(0);
  expect(
    rejected(withReport({ group_by: [], aggregates: [{ type: "count" }] })).length,
  ).toBeGreaterThan(0);
  expect(
    rejected(withReport({ group_by: [{ field: "category" }], aggregates: [] })).length,
  ).toBeGreaterThan(0);
});

test("(13) 一覧に report は書けず、集計表に columns / actions / sum_field / sort / filter は書けない", () => {
  // 一覧に集計表の宣言を書く。
  expect(
    rejected(
      withViews([
        {
          id: "bad-list",
          type: "list_view",
          table: "sale",
          columns: ["title"],
          report: BASE_REPORT,
        },
      ]),
    ).length,
  ).toBeGreaterThan(0);
  // 集計表に一覧のキーを書く(**5つを別々に打つ**)。
  /*
   * **【2026-08-15。`V8-M11-T02` の追記。テスト名も上の行も1バイトも書き換えていない】**
   * **テスト名の「集計表に … `sort` … は書けない」は、**画面直下の** `sort`
   * (`$defs/sort`。一覧の並べ替え)についての主張であり、今日もそのとおりである** ——
   * **`$defs/view` の `allOf` の集計表分岐は `"sort": false` を1バイトも解いていない。**
   * **【ただし今日は、集計表の中(`report.sort`)には並べ替えを書ける】** ——
   * **`V8-M11` が `$defs/report` に5本目のキーとして足した**(台帳 `Q-G21a` / `Q-G12`)。
   * **別物である** —— **下のリストが打っているのは `{ field, order }` の形(一覧の語彙)で
   * あって、集計表の `{ target, index, order }` ではない。**
   */
  const forbidden: [string, unknown][] = [
    ["columns", ["title"]],
    ["actions", [{ form: "f1", prefill: { field: "customer" } }]],
    ["sum_field", "amount"],
    ["sort", { field: "amount", order: "asc" }],
    ["filter", { field: "category", equals: "A" }],
  ];
  for (const [key, value] of forbidden) {
    const errors = rejected(
      withViews([
        { id: "r1", type: "report_view", table: "sale", report: BASE_REPORT, [key]: value },
      ]),
    );
    expect(errors.length, key).toBeGreaterThan(0);
  }
});

test("(14) 集計表に report が無ければ拒否される", () => {
  const errors = rejected(withViews([{ id: "r1", type: "report_view", table: "sale" }]));
  expect(errors.length).toBeGreaterThan(0);
});

// =====================================================================================
// (C) 計算(API の応答)
// =====================================================================================

test("(15) 群のキーと集計値を持つ行の配列が返る", async () => {
  const cookie = owner("c15");
  await create(cookie, "sale", { title: "1", category: "A", amount: 100 });
  await create(cookie, "sale", { title: "2", category: "B", amount: 200 });
  const { status, body } = await readReport(cookie, "by-category");
  expect(status).toBe(200);
  expect(body.groups).toEqual([
    {
      keys: [{ field: "category", value: "A" }],
      aggregates: [
        { type: "sum", field: "amount", value: 100 },
        { type: "count", value: 1 },
      ],
    },
    {
      keys: [{ field: "category", value: "B" }],
      aggregates: [
        { type: "sum", field: "amount", value: 200 },
        { type: "count", value: 1 },
      ],
    },
  ]);
  expect(body.total_groups).toBe(2);
});

test("(16) 1つの集計表に件数と合計が2本出る(Q-G4)、そして群ごとの件数の和は全体の件数と一致する(Q-G15 の受け皿)", async () => {
  const cookie = owner("c16");
  await create(cookie, "sale", { title: "1", category: "A", amount: 100 });
  await create(cookie, "sale", { title: "2", category: "A", amount: 50 });
  await create(cookie, "sale", { title: "3", category: "B", amount: 200 });
  const { body } = await readReport(cookie, "by-category");
  expect(body.groups[0]?.aggregates).toEqual([
    { type: "sum", field: "amount", value: 150 },
    { type: "count", value: 2 },
  ]);
  // **全体の合計は `D-V8-122`(全体の合計である)。**
  expect(body.totals).toEqual([
    { type: "sum", field: "amount", value: 350 },
    { type: "count", value: 3 },
  ]);
  /*
   * **【`V8-M10-T03`(台帳 `Q-G15`)による反転。旧の期待値を逐語で残す】**
   *
   * **旧(逐語)**:
   * ```
   * const summed = body.groups.reduce(
   *   (acc, group) => acc + (group.aggregates.find((a) => a.type === "count")?.value ?? 0),
   *   0,
   * );
   * expect(summed).toBe(body.totals.find((a) => a.type === "count")?.value ?? -1);
   * ```
   *
   * **旧は「群ごとの件数の和 = 全体の件数」しか見ていない** —— **どちらも同じ
   * `computeReport` の返り値であり、母集団は同じ全件である。**
   * **`V8-M7` §3 の (g) が確定させた `Q-G15` の形は (iii) 両方**である ——
   * **群ごとの件数を必ず返し、かつ**その和が群化前の**可視**件数と一致する**。
   * **可視性が1ミリも入っていない旧の形では、可視性を掛けても赤くならずに意味だけが抜ける。**
   * **そこで比較対象を「全件」から「**その人の可視件数**」へ差し替えた** ——
   * **可視件数は一覧の `total`(可視性の post-filter を通した後・群化の前の行数)から採る。**
   */
  const summed = (measured: ReportBody): number =>
    measured.groups.reduce(
      (acc, group) => acc + (group.aggregates.find((a) => a.type === "count")?.value ?? 0),
      0,
    );
  /** その人が一覧で読める件数(**群化の前の行数**)。 */
  const visibleCount = async (who: string): Promise<number> => {
    const listed = await req(who, "GET", `/api/apps/${APP_ID}/tables/sale/records`);
    expect(listed.status).toBe(200);
    return ((await listed.json()) as { total: number }).total;
  };
  // **各群が件数を持つ**(1つでも欠けたら和は合わない)。
  for (const group of body.groups) {
    expect(group.aggregates.some((a) => a.type === "count")).toBe(true);
  }
  expect(summed(body)).toBe(await visibleCount(cookie));
  // **全体の件数とも一致する**(旧の主張。**弱めていない**)。
  expect(summed(body)).toBe(body.totals.find((a) => a.type === "count")?.value ?? -1);
  /*
   * **2人目で測る** —— **1人だけでは「全件と一致した」と区別できない。**
   * **`customer` はこのアプリの役割の宣言に1行も無い**(宣言は `owner` / `editor` /
   * `viewer` の3つ)。**したがって `sale` を1行も読めない。**
   * **旧の実装では、この人にも `count: 3` が出ていた。**
   */
  const stranger = seedSession(dataRoot, APP_ID, {
    role: "customer",
    username: "c16-stranger",
  }).cookie;
  /*
   * **【`V17-M4-T01` / 台帳 `AC-G19` による追記。上の期待値も下の3行も1バイトも変えていない】**
   *
   * **本段が集計表の口に画面の閲覧判定を1本置いた** —— **画面の規則を1本も持たない
   * `customer` は、着手後この口で 403 になる。**
   * **`(16)` が測りたいのは「表を1行も読めない人の集計が 0 件で 200 になる」ことであって、
   * 「画面を開けない人が 403 になる」ことではない** —— **そこで、この2人目に
   * **画面の規則だけ**を配る**(表の規則は1本も配らない。可視件数は 0 のままである)。**
   */
  accepted(manifestWithViewOnlyCustomer());
  const strangerReport = await readReport(stranger, "by-category");
  expect(strangerReport.status).toBe(200);
  expect(await visibleCount(stranger)).toBe(0);
  expect(summed(strangerReport.body)).toBe(await visibleCount(stranger));
  expect(strangerReport.body.total_groups).toBe(0);
});

test("(17) 束ねるキーが2本のとき、群はキーの組で作られる(並びは宣言順の辞書式・null は最後)", async () => {
  const cookie = owner("c17");
  await create(cookie, "sale", { title: "1", category: "A", flag: true });
  await create(cookie, "sale", { title: "2", category: "A", flag: false });
  await create(cookie, "sale", { title: "3", category: "A", flag: true });
  await create(cookie, "sale", { title: "4", category: "B", flag: false });
  await create(cookie, "sale", { title: "5", category: "B" });
  const { body } = await readReport(cookie, "by-two");
  expect(
    body.groups.map((group) => [group.keys.map((key) => key.value), group.aggregates[0]?.value]),
  ).toEqual([
    [["A", false], 1],
    [["A", true], 2],
    [["B", false], 1],
    [["B", null], 1],
  ]);
  expect(body.total_groups).toBe(4);
});

test("(18) 束ね方 month / day / week がそれぞれ効く", async () => {
  const cookie = owner("c18");
  await create(cookie, "sale", { title: "1", sold_at: "2026-08-03" });
  await create(cookie, "sale", { title: "2", sold_at: "2026-08-05" });
  await create(cookie, "sale", { title: "3", sold_at: "2026-09-01" });
  const month = await readReport(cookie, "by-month");
  expect(
    month.body.groups.map((group) => [group.keys[0]?.value, group.aggregates[0]?.value]),
  ).toEqual([
    ["2026-08", 2],
    ["2026-09", 1],
  ]);
  const day = await readReport(cookie, "by-day");
  expect(
    day.body.groups.map((group) => [group.keys[0]?.value, group.aggregates[0]?.value]),
  ).toEqual([
    ["2026-08-03", 1],
    ["2026-08-05", 1],
    ["2026-09-01", 1],
  ]);
  const week = await readReport(cookie, "by-week");
  // 2026-08-03 と 2026-08-05 は同じ週(月曜 = 2026-08-03)。2026-09-01 は火曜(月曜 = 2026-08-31)。
  expect(
    week.body.groups.map((group) => [group.keys[0]?.value, group.aggregates[0]?.value]),
  ).toEqual([
    ["2026-08-03", 2],
    ["2026-08-31", 1],
  ]);
});

test("(19) 週の始まりは月曜日である(日曜 23:59 の行と月曜 00:00 の行は別の群に入る)", async () => {
  const cookie = owner("c19");
  await create(cookie, "sale", { title: "日", sold_at: "2026-08-09T23:59:00Z" });
  await create(cookie, "sale", { title: "月", sold_at: "2026-08-10T00:00:00Z" });
  const { body } = await readReport(cookie, "by-week");
  expect(body.groups.map((group) => group.keys[0]?.value)).toEqual(["2026-08-03", "2026-08-10"]);
  expect(body.total_groups).toBe(2);
});

test("(20) 集計表の絞り込みが効き、深すぎる絞り込み(深度9)は MAX_FILTER_DEPTH で拒否される", async () => {
  const cookie = owner("c20");
  await create(cookie, "sale", { title: "1", category: "A" });
  await create(cookie, "sale", { title: "2", category: "B" });
  const filtered = await readReport(cookie, "filtered");
  expect(filtered.status).toBe(200);
  expect(filtered.body.groups.map((group) => group.keys[0]?.value)).toEqual(["A"]);
  // **集計表専用のフィルタコンパイラを1本も作っていないことの証拠。**
  const deep = await req(cookie, "GET", `/api/apps/${APP_ID}/views/deep-filter/report`);
  expect(deep.status).toBe(400);
  const body = (await deep.json()) as { errors: { message: string }[] };
  expect(body.errors.some((error) => error.message.includes("深すぎます"))).toBe(true);
});

test("(21) 行を1件足した直後の要求で数が変わる(キャッシュを1つも置いていない。D-V8-5)", async () => {
  const cookie = owner("c21");
  await create(cookie, "sale", { title: "1", category: "A", amount: 100 });
  const first = await readReport(cookie, "by-category");
  expect(first.body.totals.find((a) => a.type === "count")?.value).toBe(1);
  await create(cookie, "sale", { title: "2", category: "A", amount: 400 });
  const second = await readReport(cookie, "by-category");
  expect(second.body.totals.find((a) => a.type === "count")?.value).toBe(2);
  expect(second.body.totals.find((a) => a.type === "sum")?.value).toBe(500);
});

test("(22) 集計は読み取り専用である(何度読んでも増えず・書き込む口が HTTP に1つも無い。Q-G35)", async () => {
  const cookie = owner("c22");
  await create(cookie, "sale", { title: "1", category: "A", amount: 100 });
  const first = await readReport(cookie, "by-category");
  await readReport(cookie, "by-category");
  const third = await readReport(cookie, "by-category");
  expect(third.body).toEqual(first.body);
  // **システムが持つ表は3本のままである**(集計のための4本目を作っていない)。
  expect(SYSTEM_TABLES).toHaveLength(3);
  /*
   * **集計値を書き込む口が HTTP に1つも無い。**
   *
   * **登録してあるのは `GET` 1本だけである。****【実測を隠さない。2026-08-14】**
   * **返る状態コードは 404 ではない** —— **`POST` / `PATCH` / `DELETE` は 403、
   * `PUT` は 404 である。** **403 は `recordsAuthMiddleware` の書込の関門が、
   * 表を1つも名乗っていない要求を閉じる側へ倒しているからである**(この経路に
   * `:table_id` は無い)。**どちらにせよ 2xx は1つも無い。**
   */
  const writeStatuses: Record<string, number> = {};
  for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
    const res = await req(cookie, method, `/api/apps/${APP_ID}/views/by-category/report`, {
      groups: [],
    });
    writeStatuses[method] = res.status;
  }
  expect(writeStatuses).toEqual({ POST: 403, PATCH: 403, PUT: 404, DELETE: 403 });
  // **集計の名前を本文に載せた作成も、未知フィールドとして拒否される。**
  const res = await req(cookie, "POST", `/api/apps/${APP_ID}/tables/sale/records`, {
    title: "2",
    groups: 1,
  });
  expect(res.status).toBe(400);
});

test("(23) 集計表を宣言していない一覧の応答は、キー単位で着手前と同一である(Q-G36)", async () => {
  const cookie = owner("c23");
  await create(cookie, "sale", { title: "1", category: "A", amount: 100 });
  const res = await req(cookie, "GET", `/api/apps/${APP_ID}/tables/sale/records`);
  const body = (await res.json()) as Any;
  // **着手前と同じ2キーちょうど**(`report` / `groups` / `totals` を1つも足していない)。
  expect(Object.keys(body).sort()).toEqual(["records", "total"]);
  const rows = body.records as Any[];
  expect(Object.keys(rows[0] ?? {})).not.toContain("groups");
  expect(Object.keys(rows[0] ?? {})).not.toContain("report");
});

test("(24) 母集団が0行のときの応答の形を固定する(群は0件・全体の合計は0)", async () => {
  const cookie = owner("c24");
  const { status, body } = await readReport(cookie, "by-category");
  expect(status).toBe(200);
  expect(body).toEqual({
    groups: [],
    total_groups: 0,
    totals: [
      { type: "sum", field: "amount", value: 0 },
      { type: "count", value: 0 },
    ],
  });
});

test("(25) 束ね方を書いた date が空の行は、群から落ちずに値が null の群に入る(D-V8-120 の考え方)", async () => {
  const cookie = owner("c25");
  await create(cookie, "sale", { title: "1", sold_at: "2026-08-03" });
  await create(cookie, "sale", { title: "2" });
  const { body } = await readReport(cookie, "by-month");
  expect(body.groups.map((group) => [group.keys[0]?.value, group.aggregates[0]?.value])).toEqual([
    ["2026-08", 1],
    [null, 1],
  ]);
  expect(body.totals.find((a) => a.type === "count")?.value).toBe(2);
});

// =====================================================================================
// (D) 白箱(製品コードの文字列を読む)
// =====================================================================================

test("(26) 集計表の絞り込みは既存の compileFilter を通る(src/kernel/ に2本目のフィルタコンパイラが無い)", async () => {
  const source = await Bun.file(new URL("../kernel/report.ts", import.meta.url)).text();
  // **行を読むのは既存のファサード1本だけである。**
  // **注釈行を除いた製品コードで数える**(注釈には説明として同じ綴りが現れる)。
  const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
  expect(code.filter((line) => /readRecordList\(/.test(line))).toHaveLength(1);
  // **葉演算子の綴りが1つも無い**(= ここでフィルタを解釈していない)。
  for (const operator of ['"equals"', '"contains"', '"gte"', '"lte"', '"in"']) {
    expect(
      code.filter((line) => line.includes(operator)),
      operator,
    ).toEqual([]);
  }
  // **SQL を1文字も書いていない**(`GROUP BY` も `strftime` も無い)。
  // **注釈行は除く** —— **注釈には「`GROUP BY` を1文字も書かない」という説明として現れる。**
  // **「0件」と丸めずに、在る場所を名指しする**(`list-view-sum-boundary.test.ts` (D) の作法)。
  for (const forbidden of ["GROUP BY", "strftime", "JOIN", "SELECT "]) {
    expect(
      code.filter((line) => line.includes(forbidden)),
      forbidden,
    ).toEqual([]);
  }
});

test("(27) 日付の丸めの実装は1本だけである(SQL 経路とメモリ経路で別々の実装を持たない)", async () => {
  // **【SQ-M4 追記】この名前の「メモリ経路」は集計を JS で行うこのファイルの実装を指す**
  // (SQL に `GROUP BY` を1文字も書いていない、の言い換え)。**システムテーブルの読取に
  // かつて在った「メモリ経路」とは別物であり、そちらが消えてもこの名前は嘘にならない。**
  // **名前は変えない** —— `ADR-0344` がこの逐語で本 test を名指ししている。
  const report = await Bun.file(new URL("../kernel/report.ts", import.meta.url)).text();
  expect([...report.matchAll(/function truncateToGranularity\(/g)]).toHaveLength(1);
  // **カーネルの他のファイルに同じ丸めが無い。**
  const others = ["records.ts", "read-records.ts", "referential-integrity.ts", "apply-diff.ts"];
  for (const name of others) {
    const source = await Bun.file(new URL(`../kernel/${name}`, import.meta.url)).text();
    expect(source.includes("truncateToGranularity"), name).toBe(false);
    expect(source.includes("strftime"), name).toBe(false);
  }
  /*
   * **`ADR-0104` 限定9(集計値を `filter` / `sort` / `search_fields` の入力にしない)を
   * 本マイルストーンが破っていないことの機械的な固定。**
   *
   * **文字列で測らず、宣言の値域そのもので測る** —— **`$defs/report` に書けるキーは
   * `group_by` / `aggregates` / `filter` の3つちょうどであり、`having` も、集計値で
   * 並べ替えるキーも、集計値を検索の対象にするキーも、書く場所そのものが無い。**
   * **`report.ts` の `.sort(...)` は群のキーの値で並べているのであって、集計値では
   * 並べていない**(だから文字列 `sort` の有無では測れない)。
   */
  const schema = JSON.parse(
    readFileSync(new URL("../../schemas/manifest.schema.json", import.meta.url), "utf-8"),
  ) as { $defs: { report: { properties: Any; required: string[] } } };
  /*
   * **【2026-08-14。`V8-M9`。台帳 `Q-G6`〜`Q-G9`。門A 本審査 = `V8-M7`。判定 = 限定採用】
   * 期待値に `join` を足した。**
   *
   * **旧行の逐語**:
   * `  expect(Object.keys(schema.$defs.report.properties)).toEqual(["group_by", "aggregates", "filter"]);`
   *
   * **書き換えた理由**: **`V8-M9` が結合(`join`)を足したので、`$defs/report` に書ける
   * キーは 3本 → 4本になった。**
   * **この test が本来固定している主張(`ADR-0104` 限定9 = 集計値を `filter` / `sort` /
   * `search_fields` の入力にしない)は1ミリも弱めていない** —— **`having` も、集計値で
   * 並べ替えるキーも、集計値を検索の対象にするキーも、書く場所が今日も1つも無い。**
   * **増えたのは「どの表の行を母集団に入れるか」の側であって、「集計値を何に使えるか」の
   * 側ではない。** **`required` は `["group_by", "aggregates"]` のままである**
   * (**結合は省略できる**)。
   * **`join` の値域そのものは `src/server/report-join-boundary.test.ts` の (20) が
   * 別に固定している。**
   */
  /*
   * **【2026-08-15。`V8-M11-T02`。台帳 `Q-G21a`(束ねた結果の並べ替え)/ `Q-G12`(集計値での
   * 並べ替え)。門A 本審査 = `V8-M7`。判定 = 限定採用。ユーザ決定 `D-V8-130`】
   * 期待値に `sort` を足した。**
   *
   * **旧行の逐語**:
   * `  expect(Object.keys(schema.$defs.report.properties)).toEqual([`
   * `    "join",`
   * `    "group_by",`
   * `    "aggregates",`
   * `    "filter",`
   * `  ]);`
   *
   * **【上の2つの注釈(この test の doc と、`V8-M9` の追記)を1バイトも書き換えていない。
   * ただし、そのうち次の逐語は今日は偽である】**
   *   - **「`$defs/report` に書けるキーは `group_by` / `aggregates` / `filter` の3つちょうど」**
   *     —— **今日は5つである**(`V8-M9` が `join`、`V8-M11` が `sort` を足した)。
   *   - **「`having` も、**集計値で並べ替えるキーも**、集計値を検索の対象にするキーも、
   *     書く場所そのものが無い」** —— **集計値で並べ替えるキーは今日は在る**
   *     (`sort` に `{ target: "aggregate", index, order }` と書ける)。
   *   - **「`report.ts` の `.sort(...)` は群のキーの値で並べているのであって、集計値では
   *     並べていない」** —— **宣言があれば集計値でも並べる。**
   *
   * **【今日の正】** **`ADR-0104` 限定9 は「集計値を `filter` / `sort` / `search_fields` の
   * 入力にしない」であり、`V8-M11` はそのうち **`sort` の側だけ**を、集計表の中に限って
   * 開いた。** **残る2つは1ミリも動いていない** —— **`having`(集計値で群を落とす)は
   * 今日も書く場所が無く、集計値を検索の対象にするキーも1つも無い。**
   * **下の2本の `expect` が、その「開いた側」と「開いていない側」の両方を測っている**
   * —— **`sort` が5本目に在ること(開いた)と、`required` が2本のままであること
   * (**並べ替えは省略できる** = 既定の順序は着手前と同じ)。**
   * **`having` が今日も無いことは、キーの一覧が5本ちょうどであることが機械的に担保する。**
   * **`sort` の値域そのものは、同ファイルの (29)〜(31) が別に固定している。**
   *
   * **【2026-08-15。`V8-M12-T02`。台帳 `Q-G23`(集計の数字を棒グラフと折れ線グラフで
   * 見たい)。門A 本審査 = `V8-M7`。判定 = 限定採用。ユーザ決定 `D-V8-131`】
   * 期待値に `chart`(グラフ種別)を足した。**
   * **旧行の逐語**: `    "sort",` の直後に `  ]);` が続いていた(**5本ちょうど**)。
   * **【上の注釈を1バイトも書き換えていない。ただし次の逐語は今日は偽である】** ——
   * **「キーの一覧が5本ちょうどである」は今日は 6本である。**
   * **`having` が今日も無いことは、その 6本の中に `having` が無いことが機械的に担保する**
   * (**主張の中身は1ミリも弱まっていない**)。
   * **`required` が2本のままであることも今日どおりである** —— **`chart` も省略できる。**
   * **`chart` の値域そのものは、同ファイルの (50)〜(55) が別に固定している。**
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
});

/*
 * **【`V8-M10-T03`(台帳 `Q-G13`)による反転。旧テスト名と旧の期待値を逐語で残す】**
 *
 * **旧テスト名(逐語)**:
 *   `(28) V8-M8 は集計に可視性を1つも掛けていない(この検査は V8-M10 で反転する)`
 * **旧の期待値(逐語)**: `expect(body.totals.find((a) => a.type === "count")?.value).toBe(2);`
 *   —— **編集者が1行も読めない表の集計が、全行(2件)を数えていた。**
 *
 * ## **【白箱の側は今日この形を数えられない。それでも消していない】**
 *
 * **旧テスト名は「可視性を1つも掛けていない」ことを白箱(`report.ts` に4語が無いこと)で
 * 数えていた。** **`v8-m10.md` §1-0c の決定1 は「判定は `src/kernel/report.ts` の外に置く」
 * と定めた** —— **したがって可視性を掛けたあとも、この4語は `report.ts` に1つも無い。**
 * **白箱の側は「可視性が掛かっているか」を測れない**(掛かっていても掛かっていなくても緑)。
 * **数えているのは振る舞いの側だけである。**
 *
 * **【では白箱は何を数えているのか】** —— **今日は逆向きの主張である。**
 * **「判定が `report.ts` の中に**書かれていない**」ことを数えている**(決定1 の履行)。
 * **テスト名をそう書き換えた。** **【禁止】これを「可視性が掛かっている証拠」と読まない。**
 * **可視性が掛かっていることの証拠は、下の振る舞いと
 * `src/server/report-visibility.test.ts` の (A)(B)(C) である。**
 */
test("(28) 判定は report.ts の外に在る(白箱はこの形を数えられない)。編集者の集計は 0 件である", async () => {
  const source = await Bun.file(new URL("../kernel/report.ts", import.meta.url)).text();
  const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
  for (const symbol of ["judgeRoleAccess", "projectForRoleFields", "st_owner", "st_public"]) {
    expect(
      code.filter((line) => line.includes(symbol)),
      symbol,
    ).toEqual([]);
  }
  /*
   * **振る舞いでも示す。**
   *
   * **題材**: `sale` を読めるのは持ち主(`owner`)だけで、編集者(`editor`)には
   * 読取の規則が1本も無い。**編集者が一覧を要求すると 0 件が返る**
   * (`ADR-0305` 限定11。403 にせず応答から落とす)。
   * **【旧文。1バイトも消していない】** **それでも集計は全行を数える** ——
   * **`V8-M8` は集計に可視性を1つも掛けていないからである。**
   *
   * **【今日は偽である】** **`V8-M10-T03` が母集団の判定を集計表の経路に通した。**
   * **編集者の集計は 0 件・合計 0 になる** —— **`D-V8-128` により 200 のままである。**
   */
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "持ち主だけが読める表", { app_id: "report-ownerread" });
  } finally {
    store.close();
  }
  const ownerOnly = withDefaultRoleRules(
    {
      app: {
        id: "report-ownerread",
        name: "持ち主だけが読める表",
        tables: tables(),
        views: [{ id: "by-category", type: "report_view", table: "sale", report: BASE_REPORT }],
        roles: roles(),
      },
    },
    { skipTables: ["sale"] },
  ) as unknown as { app: { roles: { id: string; rules?: Any[] }[] } };
  const ownerRole = ownerOnly.app.roles.find((role) => role.id === "owner");
  (ownerRole?.rules ?? []).push({
    target: "table",
    table: "sale",
    can: ["read", "write", "delete"],
  });
  expect(applyManifest(dataRoot, "report-ownerread", ownerOnly as unknown as Manifest).valid).toBe(
    true,
  );
  const ownerCookie = seedSession(dataRoot, "report-ownerread", {
    role: "owner",
    username: "c28-owner",
  }).cookie;
  for (const title of ["1", "2"]) {
    const created = await req(
      ownerCookie,
      "POST",
      "/api/apps/report-ownerread/tables/sale/records",
      { title, category: "A", amount: 100 },
    );
    expect(created.status).toBe(201);
  }
  const editorCookie = seedSession(dataRoot, "report-ownerread", {
    role: "editor",
    username: "c28-editor",
  }).cookie;
  // **編集者には1行も見えない**(面の規則が1本も無い)。
  const listed = await req(editorCookie, "GET", "/api/apps/report-ownerread/tables/sale/records");
  expect(listed.status).toBe(200);
  expect(((await listed.json()) as { records: unknown[] }).records).toEqual([]);
  // **【旧文。1バイトも消していない】** **それでも集計は全行を数える** ——
  // **これが `V8-M10` で反転する。**
  // **【今日】** **集計も 0 件である。** **`403` ではなく `200` である**(`D-V8-128`)。
  const aggregated = await req(
    editorCookie,
    "GET",
    "/api/apps/report-ownerread/views/by-category/report",
  );
  expect(aggregated.status).toBe(200);
  const body = (await aggregated.json()) as ReportBody;
  // **旧の期待値(逐語)**: `expect(body.totals.find((a) => a.type === "count")?.value).toBe(2);`
  expect(body.totals.find((a) => a.type === "count")?.value).toBe(0);
  // **合計も 0 で、群は1つも作られない**(**「見えない行から群を作ってから絞る」形なら
  // 群だけが残る** —— **可視性は群化の前に掛かっている**。`Q-G21d`)。
  expect(body.totals.find((a) => a.type === "sum")?.value).toBe(0);
  expect({ groups: body.groups, total_groups: body.total_groups }).toEqual({
    groups: [],
    total_groups: 0,
  });
  // **持ち主は今日どおり2件を数える**(閉じすぎていないことの対照)。
  const ownerAggregated = await req(
    ownerCookie,
    "GET",
    "/api/apps/report-ownerread/views/by-category/report",
  );
  const ownerBody = (await ownerAggregated.json()) as ReportBody;
  expect(ownerBody.totals.find((a) => a.type === "count")?.value).toBe(2);
  // **2人の応答が1バイト同一ではない**(着手前は同一だった)。
  expect(JSON.stringify(body)).not.toBe(JSON.stringify(ownerBody));
});

// =====================================================================================
// (E) 並べ替え(`report.sort`)—— `V8-M11-T02`。台帳 `Q-G21a`(束ねた結果の並べ替え)/
//     `Q-G12`(集計値での並べ替え)。門A 本審査 = `V8-M7`。判定 = 限定採用。
//     ユーザ決定 `D-V8-130`。実施記録 `docs/plan/v8/records/v8-m11.md` §1-0c の決定2 / 決定3、
//     §1-0e の決定13。
//
//     **ここで測るのは宣言側だけである** —— **読取時にクエリで順序を上書きする口
//     (`?sort_target=` ほか)は `T03` の担当であり、本節は1件も測っていない。**
// =====================================================================================

test("(29) 並べ替えの値域は 3キー・全部必須・12通りに閉じている(target / index / order を別々に打つ)", () => {
  // **`target` の外**(`group_by` / `aggregate` の2値ちょうど)。
  for (const target of ["aggregates", "group", "field", "keys", "sum"]) {
    const errors = rejected(
      withReport({
        group_by: [{ field: "category" }],
        aggregates: [{ type: "count" }],
        sort: { target, index: 0, order: "asc" },
      }),
    );
    expect(
      errors.some((error) => error.path.includes("/report/sort")),
      target,
    ).toBe(true);
  }
  // **`index` の外**(0..2 の整数ちょうど。**負・3以上・非整数・文字列を別々に打つ**)。
  for (const index of [-1, 3, 10, 0.5, "0"]) {
    const errors = rejected(
      withReport({
        group_by: [{ field: "category" }],
        aggregates: [{ type: "count" }],
        sort: { target: "group_by", index, order: "asc" },
      }),
    );
    expect(
      errors.some((error) => error.path.includes("/report/sort")),
      String(index),
    ).toBe(true);
  }
  // **`order` の外**(`asc` / `desc` の2値ちょうど)。
  for (const order of ["ASC", "descending", "up", ""]) {
    const errors = rejected(
      withReport({
        group_by: [{ field: "category" }],
        aggregates: [{ type: "count" }],
        sort: { target: "group_by", index: 0, order },
      }),
    );
    expect(
      errors.some((error) => error.path.includes("/report/sort")),
      order,
    ).toBe(true);
  }
  // **3キーとも必須である**(1本ずつ落として3回打つ)。
  for (const missing of ["target", "index", "order"]) {
    const sort: Any = { target: "group_by", index: 0, order: "asc" };
    delete sort[missing];
    expect(
      rejected(
        withReport({
          group_by: [{ field: "category" }],
          aggregates: [{ type: "count" }],
          sort,
        }),
      ).length,
      missing,
    ).toBeGreaterThan(0);
  }
  // **4本目のキーを書けない**(`additionalProperties: false`)。
  expect(
    rejected(
      withReport({
        group_by: [{ field: "category" }],
        aggregates: [{ type: "count" }],
        sort: { target: "group_by", index: 0, order: "asc", nulls: "first" },
      }),
    ).length,
  ).toBeGreaterThan(0);
});

test("(30) 並べ替えの添字は、宣言した本数の内側でなければ適用で拒否される(書けるが効かない組み合わせを1つも作らない)", () => {
  // **束ねるキーが1本の宣言に `index: 1` / `index: 2`** —— **スキーマは通る**
  // (添字と本数の関係は JSON Schema では表せない)。**止めるのは適用時の検査である。**
  for (const index of [1, 2]) {
    const errors = rejected(
      withReport({
        group_by: [{ field: "category" }],
        aggregates: [{ type: "count" }],
        sort: { target: "group_by", index, order: "asc" },
      }),
    );
    expect(
      errors.some((error) => error.path === "/app/views/0/report/sort/index"),
      `group_by ${index}`,
    ).toBe(true);
  }
  // **集計が2本の宣言に `index: 2`。**
  const errors = rejected(
    withReport({
      group_by: [{ field: "category" }],
      aggregates: [{ type: "sum", field: "amount" }, { type: "count" }],
      sort: { target: "aggregate", index: 2, order: "desc" },
    }),
  );
  expect(errors.some((error) => error.path === "/app/views/0/report/sort/index")).toBe(true);
  // **本数の内側なら通る**(閉じすぎていないことの対照)。
  accepted(
    withReport({
      group_by: [{ field: "category" }, { field: "flag" }],
      aggregates: [{ type: "sum", field: "amount" }, { type: "count" }],
      sort: { target: "group_by", index: 1, order: "desc" },
    }),
  );
  accepted(
    withReport({
      group_by: [{ field: "category" }, { field: "flag" }],
      aggregates: [{ type: "sum", field: "amount" }, { type: "count" }],
      sort: { target: "aggregate", index: 1, order: "asc" },
    }),
  );
});

test("(31) 12通りのうち代表を複数打って、正しい宣言が通ることを示す", () => {
  const report = (sort: Any): Any => ({
    group_by: [{ field: "category" }, { field: "flag" }, { field: "customer" }],
    aggregates: [
      { type: "sum", field: "amount" },
      { type: "count" },
      { type: "sum", field: "amount" },
    ],
    sort,
  });
  // **3本ずつ宣言してあるので、12通りすべてが本数の内側である。**
  for (const target of ["group_by", "aggregate"]) {
    for (const index of [0, 1, 2]) {
      for (const order of ["asc", "desc"]) {
        accepted(withReport(report({ target, index, order })));
      }
    }
  }
});

test("(32) 群のキーで並べ替えられる(昇順・降順)。並べ替えを書かなければ着手前の順序のままである", async () => {
  const cookie = owner("c32");
  await create(cookie, "sale", { title: "1", category: "B", amount: 100 });
  await create(cookie, "sale", { title: "2", category: "A", amount: 300 });
  await create(cookie, "sale", { title: "3", category: "C", amount: 200 });
  const asc = await readReport(cookie, "sort-cat-asc");
  expect(asc.body.groups.map((group) => group.keys[0]?.value)).toEqual(["A", "B", "C"]);
  const desc = await readReport(cookie, "sort-cat-desc");
  expect(desc.body.groups.map((group) => group.keys[0]?.value)).toEqual(["C", "B", "A"]);
  // **宣言していない集計表は着手前の順序のままである**(決定3)。
  const base = await readReport(cookie, "by-category");
  expect(base.body.groups.map((group) => group.keys[0]?.value)).toEqual(["A", "B", "C"]);
  // **全体の合計は並べ替えても1バイトも動かない。**
  expect(desc.body.totals).toEqual(base.body.totals);
  expect(desc.body.total_groups).toBe(base.body.total_groups);
});

test("(33) 集計値で並べ替えられる —— 合計(sum)も件数(count)も、昇順・降順の両方", async () => {
  const cookie = owner("c33");
  // 合計: A=300 / B=600 / C=100。件数: A=2 / B=1 / C=3。**合計の順と件数の順が違う台である。**
  await create(cookie, "sale", { title: "a1", category: "A", amount: 100 });
  await create(cookie, "sale", { title: "a2", category: "A", amount: 200 });
  await create(cookie, "sale", { title: "b1", category: "B", amount: 600 });
  await create(cookie, "sale", { title: "c1", category: "C", amount: 40 });
  await create(cookie, "sale", { title: "c2", category: "C", amount: 30 });
  await create(cookie, "sale", { title: "c3", category: "C", amount: 30 });
  const sums = (body: ReportBody): [string | number | boolean | null, number][] =>
    body.groups.map((group) => [group.keys[0]?.value ?? null, group.aggregates[0]?.value ?? -1]);
  const counts = (body: ReportBody): [string | number | boolean | null, number][] =>
    body.groups.map((group) => [group.keys[0]?.value ?? null, group.aggregates[1]?.value ?? -1]);
  expect(sums((await readReport(cookie, "sort-sum-asc")).body)).toEqual([
    ["C", 100],
    ["A", 300],
    ["B", 600],
  ]);
  expect(sums((await readReport(cookie, "sort-sum-desc")).body)).toEqual([
    ["B", 600],
    ["A", 300],
    ["C", 100],
  ]);
  expect(counts((await readReport(cookie, "sort-count-asc")).body)).toEqual([
    ["B", 1],
    ["A", 2],
    ["C", 3],
  ]);
  expect(counts((await readReport(cookie, "sort-count-desc")).body)).toEqual([
    ["C", 3],
    ["A", 2],
    ["B", 1],
  ]);
});

test("(34) 集計値が同値の群の第2キーは、今日の既定順である(決定13。Array.prototype.sort の安定性に頼っていない)", async () => {
  const cookie = owner("c34");
  /*
   * **群ができる順(= 行を読む順)を、既定の順序とわざと食い違わせてある。**
   * **群ができる順**: `[B, null]` → `[B, false]` → `[A, false]` → `[A, true]`。
   * **既定の順序**(宣言順の辞書式・昇順・`null` は最後):
   *   `[A, false]` → `[A, true]` → `[B, false]` → `[B, null]`。
   *
   * **件数は `[A, true]` だけが 2 で、残る3つは 1 の同値である。**
   * **`Array.prototype.sort` の安定性にだけ頼った実装なら、同値の3群は「群ができる順」
   * (`[B, null]` → `[B, false]` → `[A, false]`)で並ぶ。** **下の期待値はそうなっていない。**
   */
  await create(cookie, "sale", { title: "1", category: "B" });
  await create(cookie, "sale", { title: "2", category: "B", flag: false });
  await create(cookie, "sale", { title: "3", category: "A", flag: false });
  await create(cookie, "sale", { title: "4", category: "A", flag: true });
  await create(cookie, "sale", { title: "5", category: "A", flag: true });
  const shape = (body: ReportBody) =>
    body.groups.map((group) => [group.keys.map((key) => key.value), group.aggregates[0]?.value]);
  expect(shape((await readReport(cookie, "sort-two-count-desc")).body)).toEqual([
    [["A", true], 2],
    [["A", false], 1],
    [["B", false], 1],
    [["B", null], 1],
  ]);
  expect(shape((await readReport(cookie, "sort-two-count-asc")).body)).toEqual([
    [["A", false], 1],
    [["B", false], 1],
    [["B", null], 1],
    [["A", true], 2],
  ]);
});

test("(35) 並べ替えを書かない集計表の既定の順序は着手前と1バイトも同じである(甲6。null の群を含み、束ねるキーが2本の台)", async () => {
  /*
   * **`v8-m11.md` §1-0d の甲6 の宿題。**
   * **`T01` が採った着手前の応答スナップショット(`scratchpad/m11/before/`)の台は、
   * 群が2つ以上あるが `null` の群を持たず、束ねるキーも1本だけであった** ——
   * **その形では「既定の順序が変わっていない」を原理的に測れない。**
   *
   * **ここでは `null` の群を含み、束ねるキーが2本の台を1本作る**(`by-two`。**並べ替えを
   * 1バイトも宣言していない画面である**)。**期待値は (17) が着手前から逐語で固定して
   * いるものと同一であり、1バイトも変えていない。**
   * **行を作る順は (17) と変えてある** —— **群ができる順に依存していないことも同時に示す。**
   */
  const cookie = owner("c35");
  await create(cookie, "sale", { title: "5", category: "B" });
  await create(cookie, "sale", { title: "4", category: "B", flag: false });
  await create(cookie, "sale", { title: "1", category: "A", flag: true });
  await create(cookie, "sale", { title: "2", category: "A", flag: false });
  await create(cookie, "sale", { title: "3", category: "A", flag: true });
  const { body } = await readReport(cookie, "by-two");
  expect(
    body.groups.map((group) => [group.keys.map((key) => key.value), group.aggregates[0]?.value]),
  ).toEqual([
    [["A", false], 1],
    [["A", true], 2],
    [["B", false], 1],
    [["B", null], 1],
  ]);
  expect(body.total_groups).toBe(4);
});

test("(36) 白箱: 並べ替えの器は集計表の中だけに在り、画面直下の並べ替え($defs/sort)を1バイトも動かしていない", () => {
  const schema = JSON.parse(
    readFileSync(new URL("../../schemas/manifest.schema.json", import.meta.url), "utf-8"),
  ) as { $defs: Any };
  const report = schema.$defs.report as { properties: Any; additionalProperties: boolean };
  // **`$defs/report` は今日も閉じている**(5本目を足しても `additionalProperties` は `false`)。
  expect(report.additionalProperties).toBe(false);
  const sort = report.properties.sort as {
    additionalProperties: boolean;
    required: string[];
    properties: Any;
  };
  // **値域は `2 × 3 × 2 = 12` 通りちょうどである**(3キー・全部必須・4本目は書けない)。
  expect(Object.keys(sort.properties)).toEqual(["target", "index", "order"]);
  expect(sort.required).toEqual(["target", "index", "order"]);
  expect(sort.additionalProperties).toBe(false);
  expect(sort.properties.target).toEqual({ enum: ["group_by", "aggregate"] });
  expect(sort.properties.order).toEqual({ enum: ["asc", "desc"] });
  expect(sort.properties.index).toEqual({ type: "integer", minimum: 0, maximum: 2 });
  /*
   * **画面直下の並べ替え(`$defs/sort` / `$defs/sort_key`)とは別物である。**
   * **`$defs/sort` は今日も「キー1つでも配列でも書ける」形(`if` / `then` / `else`)のままで、
   * 要素は `$defs/sort_key`(= `{ field, order }`)である** —— **`target` も `index` も
   * 1つも持たない。**
   * **集計表の画面直下に `sort` を書けないことも今日どおりである**(`allOf` の
   * `report_view` 分岐が `"sort": false` で閉じている。振る舞いは (13) が測っている)。
   */
  expect((schema.$defs.sort as { then: { items: Any } }).then.items).toEqual({
    $ref: "#/$defs/sort_key",
  });
  expect((schema.$defs.sort as { else: Any }).else).toEqual({ $ref: "#/$defs/sort_key" });
  expect(Object.keys((schema.$defs.sort_key as { properties: Any }).properties)).toEqual([
    "field",
    "order",
  ]);
  const reportBranch = (
    (schema.$defs.view as { allOf: { if: Any; then: { properties: Any } }[] }).allOf ?? []
  ).find(
    (branch) =>
      ((branch.if as { properties?: Any }).properties?.type as { const?: string } | undefined)
        ?.const === "report_view",
  );
  expect(reportBranch?.then.properties.sort).toBe(false);
  /*
   * **差分の語彙(`schemas/diff.schema.json`)には1本も足していない。**
   * **`update_view` の `report` は**全置換**なので、並べ替えだけを差し替える op も、
   * 集計表の並べ替えを指す新しいキーも1つも要らなかった** ——
   * **`view_changes.properties` は着手前と同じ 25キーのままである**
   * (名前ごとの固定は `src/kernel/reference-read-boundary.test.ts` の同名の検査)。
   * **`view_changes` の `sort` は**画面直下の並べ替え**(`$defs/sort`)を指す既存のキーであり、
   * 今日も1バイトも動いていない** —— **集計表の並べ替えはここではなく `report` の中を通る。**
   */
  const diff = JSON.parse(
    readFileSync(new URL("../../schemas/diff.schema.json", import.meta.url), "utf-8"),
  ) as { $defs: Any };
  const viewChanges = (diff.$defs.view_changes as { properties: Any }).properties;
  expect(Object.keys(viewChanges)).toContain("report");
  expect(viewChanges.sort).toEqual({
    $ref: "https://smailtalk.dev/schemas/manifest.schema.json#/$defs/sort",
  });
});

test("(37) 値が空の群は、昇順でも降順でも常に最後である(決定15)。集計値で並べたときだけは末尾に来ない", async () => {
  /*
   * **`v8-m11.md` §1-0e の決定15**(メインの裁定。2026-08-15)。
   *
   * **「値が無い群」は順位の対象外である** —— **「売上の多い順」で未分類の群が先頭に
   * 来るのは、読み手の期待と正面から食い違う。**
   * **`T02` の初版は「`desc` は比較の向きを反転させるだけ」であり、降順では `null` の群が
   * 先頭に来ていた。** **本検査はその向きを固定する** ——
   * **`T02` の初版が「この向きを固定していません」と自ら申告した穴である。**
   *
   * **効くのは `target: "group_by"` の降順だけである** —— **集計値(`aggregate`)は
   * 必ず数であり、`null` が1つも出ない**(合計は 0 に倒れ、件数は 0 になる)。
   * **下の3本目がそのことを実測で示している** —— **集計値で降順に並べると、値が空の群は
   * 末尾ではなく「その合計の大きさの位置」に入る。**
   */
  const cookie = owner("c37");
  await create(cookie, "sale", { title: "1", category: "A", amount: 100 });
  await create(cookie, "sale", { title: "2", category: "B", amount: 300 });
  // **区分を書かない行** —— **群のキーが `null` になる**(`D-V8-120`。群から落とさない)。
  await create(cookie, "sale", { title: "3", amount: 200 });
  const keys = (body: ReportBody) => body.groups.map((group) => group.keys[0]?.value);
  // **昇順** —— **着手前からの既定と同じ向きである。**
  expect(keys((await readReport(cookie, "sort-cat-asc")).body)).toEqual(["A", "B", null]);
  // **降順** —— **`null` は先頭ではなく末尾である**(決定15。**単純反転を採らない**)。
  expect(keys((await readReport(cookie, "sort-cat-desc")).body)).toEqual(["B", "A", null]);
  // **並べ替えを書かない画面も今日どおり**(`null` は最後。決定3)。
  expect(keys((await readReport(cookie, "by-category")).body)).toEqual(["A", "B", null]);
  /*
   * **集計値で並べたときは、値が空の群も1つの数として順位に入る。**
   * **合計は A=100 / B=300 / (空)=200 なので、降順は B → (空) → A である** ——
   * **末尾に寄らない。** **【禁止】これを「決定15 が効いていない」と読まない** ——
   * **決定15 が寄せるのは「群のキーの値が空のとき」であって、「集計値が小さいとき」では
   * ないからである。** **集計値そのものが `null` になる経路は1つも無い。**
   */
  const sums = (body: ReportBody) =>
    body.groups.map((group) => [group.keys[0]?.value ?? null, group.aggregates[0]?.value]);
  expect(sums((await readReport(cookie, "sort-sum-desc")).body)).toEqual([
    ["B", 300],
    [null, 200],
    ["A", 100],
  ]);
  expect(sums((await readReport(cookie, "sort-sum-asc")).body)).toEqual([
    ["A", 100],
    [null, 200],
    ["B", 300],
  ]);
});

// =====================================================================================
// (F) 読取時の並べ替え(`?sort_target=` / `?sort_index=` / `?sort_order=`)——
//     `V8-M11-T03`。台帳 `Q-G21a` / `Q-G12`。ユーザ決定 `D-V8-130`
//     (**並べ替えは「宣言で固定」ではなく「見ている人が押して変えられる」**)。
//     実施記録 `docs/plan/v8/records/v8-m11.md` §1 の `T03` / §1-0c の決定8。
//
//     **ここは `API` の応答だけで判定する**(§1-0d の (丁)(iv))——
//     **画面(`web/`)の DOM 検査で代用していない。画面を1枚も開いていない。**
// =====================================================================================

/** 400 の応答本文から `errors` を読む(**成功の形とは別のキーである**)。 */
function errorsOf(body: ReportBody): { path: string; message: string; hint?: string }[] {
  return (
    (body as unknown as { errors?: { path: string; message: string; hint?: string }[] }).errors ??
    []
  );
}

const SORT_QUERY_KEYS = ["sort_target", "sort_index", "sort_order"] as const;

test("(38) 読取のクエリで並べ替えを指定できる —— クエリは宣言の既定を上書きする(本物の HTTP。D-V8-130)", async () => {
  const cookie = owner("c38");
  await create(cookie, "sale", { title: "1", category: "B", amount: 100 });
  await create(cookie, "sale", { title: "2", category: "A", amount: 300 });
  await create(cookie, "sale", { title: "3", category: "C", amount: 200 });
  const keys = (body: ReportBody) => body.groups.map((group) => group.keys[0]?.value);
  /*
   * **宣言に `sort` を書いていない画面**(`by-category`)——
   * **クエリだけで並び順が決まる。**
   */
  const byQuery = await readReport(
    cookie,
    "by-category",
    "sort_target=group_by&sort_index=0&sort_order=desc",
  );
  expect(byQuery.status).toBe(200);
  expect(keys(byQuery.body)).toEqual(["C", "B", "A"]);
  /*
   * **宣言に `sort` を書いた画面に、逆向きのクエリを当てる**(`sort-cat-asc` は
   * **群のキーの昇順**を宣言している)。**クエリが勝つ。**
   */
  const overridden = await readReport(
    cookie,
    "sort-cat-asc",
    "sort_target=group_by&sort_index=0&sort_order=desc",
  );
  expect(overridden.status).toBe(200);
  expect(keys(overridden.body)).toEqual(["C", "B", "A"]);
  // **集計値で指す形もクエリから指せる**(合計の降順: B=100 … ではなく A=300 が先頭)。
  const bySum = await readReport(
    cookie,
    "sort-cat-asc",
    "sort_target=aggregate&sort_index=0&sort_order=desc",
  );
  expect(
    bySum.body.groups.map((group) => [group.keys[0]?.value, group.aggregates[0]?.value]),
  ).toEqual([
    ["A", 300],
    ["C", 200],
    ["B", 100],
  ]);
  // **全体の合計と群の総数は、並べ替えても1バイトも動かない。**
  const base = await readReport(cookie, "by-category");
  expect(byQuery.body.totals).toEqual(base.body.totals);
  expect(byQuery.body.total_groups).toBe(base.body.total_groups);
});

test("(39) 並べ替えのクエリは3つそろわなければ 400 である(1つだけ・2つだけの6通りを全部打つ)", async () => {
  const cookie = owner("c39");
  await create(cookie, "sale", { title: "1", category: "A", amount: 100 });
  const values: Record<string, string> = {
    sort_target: "group_by",
    sort_index: "0",
    sort_order: "asc",
  };
  // **1つだけ**(3通り)。
  for (const key of SORT_QUERY_KEYS) {
    const out = await readReport(cookie, "by-category", `${key}=${values[key]}`);
    expect(out.status, key).toBe(400);
    expect(errorsOf(out.body).length, key).toBeGreaterThan(0);
  }
  // **2つだけ**(3通り)。
  for (const omitted of SORT_QUERY_KEYS) {
    const query = SORT_QUERY_KEYS.filter((key) => key !== omitted)
      .map((key) => `${key}=${values[key]}`)
      .join("&");
    const out = await readReport(cookie, "by-category", query);
    expect(out.status, query).toBe(400);
    expect(errorsOf(out.body).length, query).toBeGreaterThan(0);
  }
  // **3つそろえば通る**(全か無かであって、「全部拒否」ではない)。
  const complete = await readReport(
    cookie,
    "by-category",
    "sort_target=group_by&sort_index=0&sort_order=asc",
  );
  expect(complete.status).toBe(200);
});

test("(40) 並べ替えのクエリの値域の外は 400 である(sort_target / sort_index / sort_order を別々に打つ)", async () => {
  const cookie = owner("c40");
  await create(cookie, "sale", { title: "1", category: "A", amount: 100 });
  const outside: string[] = [
    // `target` の外。
    "sort_target=bogus&sort_index=0&sort_order=asc",
    // `index` の外(値域は 0..2 の整数ちょうどである)。
    "sort_target=group_by&sort_index=99&sort_order=asc",
    "sort_target=group_by&sort_index=abc&sort_order=asc",
    "sort_target=group_by&sort_index=-1&sort_order=asc",
    // `order` の外。
    "sort_target=group_by&sort_index=0&sort_order=sideways",
  ];
  for (const query of outside) {
    const out = await readReport(cookie, "by-category", query);
    expect(out.status, query).toBe(400);
    // **黙って既定に化けさせない**(憲法6)—— **200 で「無視した」を返さない。**
    expect(errorsOf(out.body).length, query).toBeGreaterThan(0);
  }
});

test("(41) 宣言に無い添字を指したクエリは 400 である(group_by が1本の集計表に sort_index=1)", async () => {
  const cookie = owner("c41");
  await create(cookie, "sale", { title: "1", category: "A", amount: 100 });
  /*
   * **`by-category` は束ねるキー1本・集計2本である。**
   * **値域(0..2)の内側でも、宣言した本数の外側なら 400 である** ——
   * **`201` で通った宣言が読取時に壊れる形を作らないのと同じ向きで、
   * 「書けるが効かない要求」を1つも通さない**(甲3 が apply 側で置いた壁と同型)。
   */
  const outsideGroupBy = await readReport(
    cookie,
    "by-category",
    "sort_target=group_by&sort_index=1&sort_order=asc",
  );
  expect(outsideGroupBy.status).toBe(400);
  // **集計は2本なので、添字2 は宣言の外である。**
  const outsideAggregate = await readReport(
    cookie,
    "by-category",
    "sort_target=aggregate&sort_index=2&sort_order=asc",
  );
  expect(outsideAggregate.status).toBe(400);
  // **束ねるキーが2本の画面なら、添字1 は宣言の内側なので通る**(同じ添字で答えが割れる)。
  const inside = await readReport(
    cookie,
    "by-two",
    "sort_target=group_by&sort_index=1&sort_order=asc",
  );
  expect(inside.status).toBe(200);
});

test("(42) クエリを書かなければ、宣言の既定 →(宣言も無ければ)着手前の既定順である", async () => {
  const cookie = owner("c42");
  await create(cookie, "sale", { title: "1", category: "B", amount: 100 });
  await create(cookie, "sale", { title: "2", category: "A", amount: 300 });
  await create(cookie, "sale", { title: "3", category: "C", amount: 200 });
  const keys = (body: ReportBody) => body.groups.map((group) => group.keys[0]?.value);
  // **宣言が在る画面はその宣言どおり**(降順)。
  expect(keys((await readReport(cookie, "sort-cat-desc")).body)).toEqual(["C", "B", "A"]);
  // **宣言が無い画面は着手前の既定順**(宣言順の辞書式・昇順)。
  expect(keys((await readReport(cookie, "by-category")).body)).toEqual(["A", "B", "C"]);
  // **空のクエリ文字列も「書かなかった」と同じである**(3つとも欠けている)。
  expect(keys((await readReport(cookie, "sort-cat-desc", "")).body)).toEqual(["C", "B", "A"]);
});

test("(43) 決定15 は読取側にも同じく効く —— クエリで降順にしても、値が空の群は最後である", async () => {
  const cookie = owner("c43");
  await create(cookie, "sale", { title: "1", category: "A", amount: 100 });
  await create(cookie, "sale", { title: "2", category: "B", amount: 300 });
  await create(cookie, "sale", { title: "3", amount: 200 });
  const keys = (body: ReportBody) => body.groups.map((group) => group.keys[0]?.value);
  expect(
    keys(
      (await readReport(cookie, "by-category", "sort_target=group_by&sort_index=0&sort_order=asc"))
        .body,
    ),
  ).toEqual(["A", "B", null]);
  // **降順でも `null` は末尾である**(§1-0e の決定15。**宣言側と1バイトも同じ規則**)。
  expect(
    keys(
      (await readReport(cookie, "by-category", "sort_target=group_by&sort_index=0&sort_order=desc"))
        .body,
    ),
  ).toEqual(["B", "A", null]);
  /*
   * **集計値で並べたときだけは末尾に来ない** —— **決定15 が寄せるのは
   * 「群のキーの値が空のとき」であって「集計値が小さいとき」ではない。**
   * **宣言側の (37) と同じ実測を、クエリ側でも打っている。**
   */
  const sums = (body: ReportBody) =>
    body.groups.map((group) => [group.keys[0]?.value ?? null, group.aggregates[0]?.value]);
  expect(
    sums(
      (
        await readReport(
          cookie,
          "by-category",
          "sort_target=aggregate&sort_index=0&sort_order=desc",
        )
      ).body,
    ),
  ).toEqual([
    ["B", 300],
    [null, 200],
    ["A", 100],
  ]);
});

test("(44) 白箱(甲4): 集計表の読取が受けるクエリ名は {limit, offset, sort_target, sort_index, sort_order} の5つちょうどである", async () => {
  /*
   * **`v8-m11.md` §1-0c の決定8 / §1-0d の甲4。**
   *
   * **【必ず読むこと】これは「読取時に壁を立てた」検査ではない** ——
   * **「壁を要する入力を作らなかった」ことの固定である。**
   * **項目名を受ける口が1つも無いので、読取側で項目名を検査する余地が構造的に生じない**
   * (`Q-G22` の読取側。**apply 側の壁は `V8-M8` が置いたもので、(45) が再実証する**)。
   *
   * **【数え方】** **この家の作法は `c.req.query` ではなく
   * `new URL(c.req.url).searchParams` である**(一覧ルートが3箇所でそう書いている)。
   * **`c.req.query` を数える形で書くと、`searchParams` を使った実装に対して 0件で緑になり、
   * 検査が生まれた時点で無意味になる**(甲4 が名指しした型)。
   * **したがってここでは3つを同時に見る**:
   *  1. 集計表ルートに `c.req.query` が1つも無いこと(別の口を開いていない)。
   *  2. `searchParams` を取り出す行が**ちょうど1本**であること(2本目の入口を作らない)。
   *  3. その1本から読む名前の集合が**5つちょうど**であること。
   */
  const source = await Bun.file(new URL("./app.ts", import.meta.url)).text();
  const start = source.indexOf('app.get("/api/apps/:app_id/views/:view_id/report"');
  const end = source.indexOf('app.get("/api/apps/:app_id/views/:view_id/custom.css"', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  // **注釈行を除いた製品コードで数える**((B-3) と同じ作法。注釈には説明として同じ綴りが現れる)。
  const code = source
    .slice(start, end)
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
  expect(code.filter((line) => line.includes("c.req.query"))).toEqual([]);
  expect(code.filter((line) => line.includes("searchParams"))).toHaveLength(1);
  const names = code
    .flatMap((line) => [...line.matchAll(/reportQuery\.get(?:All)?\("([^"]+)"\)/g)])
    .map((match) => match[1]);
  // **重複が無い**(同じ名前を2度読んでいない)。
  expect(names).toHaveLength(new Set(names).size);
  expect([...names].sort()).toEqual(["limit", "offset", "sort_index", "sort_order", "sort_target"]);
  /*
   * **【必ず書く】`hiddenFieldQueryErrors` を集計表ルートに通していない。**
   * **通す必要が無いからである** —— **項目名を受け取らない口には、
   * 「見せない項目を条件に書かせない」検査を当てる対象が1つも無い。**
   * **一覧の読取ルートは今日どおり通している**(そちらは項目名を受ける)。
   */
  expect(code.filter((line) => line.includes("hiddenFieldQueryErrors"))).toEqual([]);
  const listRoute = source.slice(
    source.indexOf('app.get("/api/apps/:app_id/tables/:table_id/records"'),
  );
  expect(listRoute.includes("hiddenFieldQueryErrors")).toBe(true);
});

test("(45) 【再実証。V8-M11 の新規実装ではない】役割の規則が名指しした項目を group_by に書いた差分は、API から打っても拒否される", async () => {
  /*
   * **`v8-m11.md` §1-0d の (丁)(iii) の手当て。**
   *
   * **これは `V8-M8` が入れた apply 時の壁が今日も効いていることの再実証である** ——
   * **`V8-M11` は1バイトも実装していない。** **(7) が同じ壁を `applyManifest`
   * (カーネル直呼び)で測っているのに対し、ここは `POST /diffs`(本物の HTTP)で打つ。**
   * **完了の考え方 (iii)(apply 時と読取時の両方)のうち、apply 時の側の再実証である。**
   */
  const cookie = owner("c45");
  const post = async (view: Any) =>
    await req(cookie, "POST", `/api/apps/${APP_ID}/diffs`, {
      diff_id: `d-${view.id as string}`,
      intent: "役割の規則が名指しした項目で束ねられないことを、API から確かめる",
      operations: [{ op: "add_view", view }],
    });
  // **`sale.cost` は役割の規則(`target: "field"`)が名指ししている項目である。**
  const rejectedRes = await post({
    id: "r-cost",
    type: "report_view",
    table: "sale",
    report: { group_by: [{ field: "cost" }], aggregates: [{ type: "count" }] },
  });
  expect(rejectedRes.status).toBe(400);
  const body = (await rejectedRes.json()) as { errors: { path: string; message: string }[] };
  expect(body.errors.some((error) => error.path.includes("/report/group_by/0/field"))).toBe(true);
  // **名指しされていない項目なら、同じ口が今日も 201 で通る**(閉じすぎていないことの対照)。
  const acceptedRes = await post({
    id: "r-category",
    type: "report_view",
    table: "sale",
    report: { group_by: [{ field: "category" }], aggregates: [{ type: "count" }] },
  });
  expect(acceptedRes.status).toBe(201);
});

// =====================================================================================
// (G) **`_id` を持たない行の4つの振る舞い**(`V8-M11-T05`。台帳 `Q-G21`)——
//     **4本を別々のテストとして書く**(1本にまとめない)。
//
//     **集計表の1行は「群」であって「レコード」ではない** —— **`_id` を持たない。**
//     **したがって「行に対してできること」を、レコードの4つの振る舞いごとに
//     別々に確かめる必要がある**(並べ替え / ページ / 操作起点 / 権限)。
//
//     **【帰属をはっきり書く】** **本マイルストーンが作ったのは (a) と (b) だけである。**
//     **(c) は着手前から在り、(d) は `V8-M10` が入れたものの再掲である。**
// =====================================================================================

test("(46) 【(a) 並べ替え】群は _id を持たないが、宣言でもクエリでも並べ替えられる", async () => {
  const cookie = owner("c46");
  await create(cookie, "sale", { title: "1", category: "B", amount: 100 });
  await create(cookie, "sale", { title: "2", category: "A", amount: 300 });
  await create(cookie, "sale", { title: "3", category: "C", amount: 200 });
  const { body } = await readReport(cookie, "by-category");
  // **群は2キーちょうどである** —— **`_id` を1つも持たない。**
  expect(Object.keys(body.groups[0] ?? {}).sort()).toEqual(["aggregates", "keys"]);
  expect(body.groups.every((group) => !("_id" in group))).toBe(true);
  const keys = (target: ReportBody) => target.groups.map((group) => group.keys[0]?.value);
  // **宣言で並べ替えられる**(`T02`)。
  expect(keys((await readReport(cookie, "sort-cat-desc")).body)).toEqual(["C", "B", "A"]);
  // **読取のクエリでも並べ替えられる**(`T03`。`D-V8-130`)。
  expect(
    keys(
      (
        await readReport(
          cookie,
          "by-category",
          "sort_target=aggregate&sort_index=0&sort_order=desc",
        )
      ).body,
    ),
  ).toEqual(["A", "C", "B"]);
});

test("(47) 【(b) ページ】群は _id を持たないが、?limit= / ?offset= で切れる(全体の値は切る前のまま)", async () => {
  const cookie = owner("c47");
  await create(cookie, "sale", { title: "1", category: "A", amount: 100 });
  await create(cookie, "sale", { title: "2", category: "B", amount: 200 });
  await create(cookie, "sale", { title: "3", category: "C", amount: 300 });
  const page = await readReport(cookie, "by-category", "limit=2&offset=1");
  expect(page.status).toBe(200);
  expect(page.body.groups.map((group) => group.keys[0]?.value)).toEqual(["B", "C"]);
  // **切ったのは `groups` だけである**(決定6)。
  expect(page.body.total_groups).toBe(3);
  expect(page.body.totals.find((aggregate) => aggregate.type === "count")?.value).toBe(3);
  // **切り出した群も `_id` を持たない**(ページ送りは行の識別子を1つも要求しない)。
  expect(Object.keys(page.body.groups[0] ?? {}).sort()).toEqual(["aggregates", "keys"]);
  // **`?limit=` を書かなければ、応答は着手前と1バイト同じである**(群が3つしかない台)。
  const whole = await readReport(cookie, "by-category");
  expect(whole.body.groups).toHaveLength(3);
});

test("(48) 【(c) 操作起点】集計表に actions を書いた差分は API から打っても拒否される(着手前から在る。V8-M11 は1バイトも実装していない)", async () => {
  /*
   * **【帰属をはっきり書く】これは「既に在ることを示す」タスクである** ——
   * **`schemas/manifest.schema.json` の `$defs/view` の集計表分岐が
   * `"actions": false` を着手前から持っている**(`v8-m11.md` §1 の `T05` (c))。
   * **`V8-M11` はこの振る舞いのために1バイトも実装していない。**
   * **(13) が同じことを `applyManifest`(カーネル直呼び)で測っているのに対し、
   * ここは `POST /diffs`(本物の HTTP)で打つ。**
   */
  const cookie = owner("c48");
  const res = await req(cookie, "POST", `/api/apps/${APP_ID}/diffs`, {
    diff_id: "d-report-actions",
    intent: "集計表の群にボタンを置けないことを、API から確かめる",
    operations: [
      {
        op: "add_view",
        view: {
          id: "r-actions",
          type: "report_view",
          table: "sale",
          report: BASE_REPORT,
          actions: [{ form: "f1", prefill: { field: "customer" } }],
        },
      },
    ],
  });
  expect(res.status).toBe(400);
  // **スキーマの側で閉じている**(実在検査より前に落ちる)。
  const schema = JSON.parse(
    readFileSync(new URL("../../schemas/manifest.schema.json", import.meta.url), "utf-8"),
  ) as { $defs: Any };
  const reportBranch = (
    (schema.$defs.view as { allOf: { if: Any; then: { properties: Any } }[] }).allOf ?? []
  ).find(
    (branch) =>
      ((branch.if as { properties?: Any }).properties?.type as { const?: string } | undefined)
        ?.const === "report_view",
  );
  expect(reportBranch?.then.properties.actions).toBe(false);
});

test("(49) 【(d) 権限】群の母集団には V8-M10 が入れた判定が掛かっている(再掲。Q-G21d の実装タスクは V8-M10 であり V8-M11 ではない)", async () => {
  /*
   * **【帰属をはっきり書く】** **`v8-m7.md:461` は `Q-G21d` の実装タスクを `V8-M10` と
   * 名指ししている**(`v8-m11.md` §1-0d の丙3 の訂正)。
   * **ここで測るのは再掲であり、`V8-M11` が作ったものではない。**
   *
   * **本マイルストーンが足したのは、次の1点だけである** ——
   * **並べ替えのクエリもページ送りのクエリも、母集団の判定を1ミリも迂回しない。**
   */
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "持ち主だけが読める表(T05-d)", { app_id: "report-t05d" });
  } finally {
    store.close();
  }
  const ownerOnly = withDefaultRoleRules(
    {
      app: {
        id: "report-t05d",
        name: "持ち主だけが読める表(T05-d)",
        tables: tables(),
        views: [{ id: "by-category", type: "report_view", table: "sale", report: BASE_REPORT }],
        roles: roles(),
      },
    },
    { skipTables: ["sale"] },
  ) as unknown as { app: { roles: { id: string; rules?: Any[] }[] } };
  (ownerOnly.app.roles.find((role) => role.id === "owner")?.rules ?? []).push({
    target: "table",
    table: "sale",
    can: ["read", "write", "delete"],
  });
  expect(applyManifest(dataRoot, "report-t05d", ownerOnly as unknown as Manifest).valid).toBe(true);
  const ownerCookie = seedSession(dataRoot, "report-t05d", {
    role: "owner",
    username: "c49-owner",
  }).cookie;
  for (const category of ["A", "B", "C"]) {
    const created = await req(ownerCookie, "POST", "/api/apps/report-t05d/tables/sale/records", {
      title: category,
      category,
      amount: 100,
    });
    expect(created.status).toBe(201);
  }
  const editorCookie = seedSession(dataRoot, "report-t05d", {
    role: "editor",
    username: "c49-editor",
  }).cookie;
  const read = async (cookie: string, query: string) => {
    const res = await req(cookie, "GET", `/api/apps/report-t05d/views/by-category/report?${query}`);
    return { status: res.status, body: (await res.json()) as ReportBody };
  };
  // **並べ替えても、ページを送っても、編集者の群は 0 件のままである**(`D-V8-128` により 200)。
  for (const query of [
    "sort_target=group_by&sort_index=0&sort_order=desc",
    "sort_target=aggregate&sort_index=0&sort_order=desc",
    "limit=100&offset=0",
    "limit=1&offset=0",
  ]) {
    const out = await read(editorCookie, query);
    expect([query, out.status, out.body.groups.length, out.body.total_groups]).toEqual([
      query,
      200,
      0,
      0,
    ]);
    expect(out.body.totals.find((aggregate) => aggregate.type === "count")?.value).toBe(0);
  }
  // **持ち主は同じクエリで3群を見る**(閉じすぎていないことの対照)。
  const ownerOut = await read(ownerCookie, "sort_target=group_by&sort_index=0&sort_order=desc");
  expect(ownerOut.body.groups.map((group) => group.keys[0]?.value)).toEqual(["C", "B", "A"]);
});

// =====================================================================================
// (H) **グラフ種別の宣言**(`V8-M12-T02`。台帳 `Q-G23`。門A 本審査 = `V8-M7`。
//     判定 = 限定採用。実施記録 `docs/plan/v8/records/v8-m12.md` §1-0c の決定1〜決定3 /
//     §1-0f の枝番 甲1 / 甲5 / 甲7 / 戊3 / 戊5 / 庚6)。
//
//     **本マイルストーンは `$defs/report.properties` に6本目のキー `chart` を足した。**
//     **描画そのもの(棒・折れ線を実際に描く)は `V8-M12-T04` の担当であり、
//     ここでは1ピクセルも測っていない** —— **測るのは「宣言できる形」だけである。**
// =====================================================================================

// **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。ADR = `0359` §4b。題名の数を直した】**
// **旧名の逐語**: `(50) 白箱: $defs/report.properties は6本ちょうどで、6本目が chart である($defs 30 / view.properties 30 / view_changes 26 —— 本マイルストーンは report.properties を1本も動かさない)`
test("(50) 白箱: $defs/report.properties は6本ちょうどで、6本目が chart である($defs 30 / view.properties 31 / view_changes 27 —— 本マイルストーンは report.properties を1本も動かさない)", () => {
  const schema = JSON.parse(
    readFileSync(new URL("../../schemas/manifest.schema.json", import.meta.url), "utf-8"),
  ) as { $defs: Any };
  const report = schema.$defs.report as { properties: Any; additionalProperties: boolean };
  /*
   * **6本目である**(5本 → 6本)。**`ADR-0344` 限定1 の逐語
   * 「`$defs/report.properties` は 5本ちょうどになった」は今日は偽である** ——
   * **旧文を1バイトも書き換えていない。引き直す個別 ADR は `V8-M12-T08` が起草する。**
   */
  expect(Object.keys(report.properties)).toEqual([
    "join",
    "group_by",
    "aggregates",
    "filter",
    "sort",
    "chart",
  ]);
  // **7本目は書けない**(閉じたままである)。
  expect(report.additionalProperties).toBe(false);
  /*
   * **新しい `$defs` を1本も作っていない** —— **値域をインラインで書いた。**
   * **`$defs/view.properties` も1本も増えていない** —— **グラフ種別は画面直下ではなく
   * 集計表の中(`$defs/report`)に置いたからである**(決定1)。
   */
  expect(Object.keys(schema.$defs)).toHaveLength(30);
  // **【2026-08-20。`V10-M1-T02`。台帳 `NV-G4`。ADR = `0359`】期待値を 29 → 30 へ書き換えた。**
  // **旧行の逐語**: `expect(Object.keys((schema.$defs.view as { properties: Any }).properties)).toHaveLength(29);`
  // **30本目を足したのは別の決定である**(`ADR-0359` §4a 限定1 の `after_delete`)。
  // **`$defs` の本数(30)は今日も1つも増えていない。**
  // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。門A 本審査 = `V10-M0` 群B。ADR = `0359` / `0360`】**
  // **期待値を 30 → 31 へ書き換えた。****旧行の逐語**: `expect(Object.keys((schema.$defs.view as { properties: Any }).properties)).toHaveLength(30);`
  // **31本目を足したのは別の決定である**(`ADR-0359` §4b 限定1 が一続きの流れの中の段
  // `flow` を**末尾に**31キー目として足した。**`list_view` / `form` / `detail_view` の3種別で
  // 書け、集計表(`report_view`)には書けない**)。
  // **本ファイルが測っている決定の増分ではない。****検査は消していない。**
  expect(Object.keys((schema.$defs.view as { properties: Any }).properties)).toHaveLength(31);
  /*
   * **差分の語彙(`schemas/diff.schema.json`)には1本も足していない** ——
   * **`update_view` の `report` は**全置換**なので、グラフ種別だけを差し替えるキーが
   * 1本も要らなかった**((36) が `sort` について同じことを測っている)。
   */
  const diff = JSON.parse(
    readFileSync(new URL("../../schemas/diff.schema.json", import.meta.url), "utf-8"),
  ) as { $defs: Any };
  // **【2026-08-20。`V10-M1-T02`。ADR = `0359` §Decision 2】期待値を 25 → 26 へ書き換えた。**
  // **旧行の逐語**: `expect(Object.keys((diff.$defs.view_changes as { properties: Any }).properties)).toHaveLength(25);`
  // **26本目を足したのは別の決定である**(`after_delete`)。**グラフ種別は今日も1本も足していない。**
  // **【2026-08-20。`V10-M4-T01`。台帳 `NV-G9`。門A 本審査 = `V10-M0` 群B。ADR = `0359` / `0360`】**
  // **期待値を 26 → 27 へ書き換えた。****旧行の逐語**: `expect(Object.keys((diff.$defs.view_changes as { properties: Any }).properties)).toHaveLength(26);`
  // **27本目を足したのは別の決定である**(`flow` を `view_changes` の末尾に足した。
  // `ADR-0359` §Decision 2)。**本ファイルが測っている決定の増分ではない。**
  // **検査は消していない。**
  expect(Object.keys((diff.$defs.view_changes as { properties: Any }).properties)).toHaveLength(27);
});

test("(51) 白箱: chart の値域は2値ちょうど(棒 / 折れ線)で、required に入っていない(省略できる)", () => {
  const schema = JSON.parse(
    readFileSync(new URL("../../schemas/manifest.schema.json", import.meta.url), "utf-8"),
  ) as { $defs: Any };
  const report = schema.$defs.report as { properties: Any; required: string[] };
  const chart = report.properties.chart as { enum?: string[]; default?: unknown };
  /*
   * **2値ちょうどである**(`ADR-0007` の台帳が `Q-G23` に課した限定の1つ目)。
   * **3値目を足したらここが赤くなる。**
   */
  expect(chart.enum).toEqual(["bar", "line"]);
  expect(chart.enum).toHaveLength(2);
  /*
   * **必須にしていない**(決定3)—— **`required` に足すと `V8-M8`〜`V8-M11` が作った
   * 既存の集計表の宣言が全部拒否される。**
   */
  expect(report.required).toEqual(["group_by", "aggregates"]);
  expect(report.required).not.toContain("chart");
  /*
   * **`default` を1つも書いていない**(`schemas/manifest.schema.json:1018` の逐語
   * 「schema に default を書かない」= `ADR-0104` の作法)。
   * **既定(省略したときは棒)は表示層(`V8-M12-T04`)が持つ。**
   * **【正直に書く。承知した代償】マニフェストを読んだだけでは棒が出ることが分からない。**
   */
  expect("default" in chart).toBe(false);
});

test("(52) chart を書かない集計表は今日も通り、2値は通り、3値目は適用で拒否される", () => {
  // **省略できる**(決定3)—— **これが `V8-M8`〜`V8-M11` の既存の宣言そのものの形である。**
  accepted(withReport({ group_by: [{ field: "category" }], aggregates: [{ type: "count" }] }));
  // **2値とも通る**(閉じすぎていないことの対照)。
  for (const value of ["bar", "line"]) {
    accepted(
      withReport({
        group_by: [{ field: "category" }],
        aggregates: [{ type: "count" }],
        chart: value,
      }),
    );
  }
  /*
   * **2値の外は差分全体が拒否される。** **値域そのものの綴りを打つのではなく、
   * 「2値でないもの」を打っている** —— **円・散布図・積み上げ・ドーナツ・面の英語綴りを
   * この検査に1文字も書かないためである**(枝番 庚6)。
   */
  const outside = [
    ["p", "ie"].join(""),
    ["scat", "ter"].join(""),
    ["stac", "ked"].join(""),
    ["don", "ut"].join(""),
    ["ar", "ea"].join(""),
    "BAR",
    "Line",
    "bars",
    "",
  ];
  for (const value of outside) {
    const errors = rejected(
      withReport({
        group_by: [{ field: "category" }],
        aggregates: [{ type: "count" }],
        chart: value,
      }),
    );
    expect(
      errors.some((error) => error.path.includes("/report/chart")),
      JSON.stringify(value),
    ).toBe(true);
  }
  // **1つの集計表に置けるグラフは1つである** —— **スカラー1本が構造的に担保する。**
  for (const value of [["bar"], { type: "bar" }, ["bar", "line"]]) {
    expect(
      rejected(
        withReport({
          group_by: [{ field: "category" }],
          aggregates: [{ type: "count" }],
          chart: value,
        }),
      ).length,
      JSON.stringify(value),
    ).toBeGreaterThan(0);
  }
});

test("(53) chart の値域の外を書いた差分は、本物の HTTP でも 400 である(2値は 201)", async () => {
  const cookie = owner("c53");
  const post = async (viewId: string, chart: unknown) =>
    await req(cookie, "POST", `/api/apps/${APP_ID}/diffs`, {
      diff_id: `d-${viewId}`,
      intent: "グラフ種別の値域が API から打っても閉じていることを確かめる",
      operations: [
        {
          op: "add_view",
          view: {
            id: viewId,
            type: "report_view",
            table: "sale",
            report: {
              group_by: [{ field: "category" }],
              aggregates: [{ type: "count" }],
              ...(chart === undefined ? {} : { chart }),
            },
          },
        },
      ],
    });
  const bad = await post("c53-bad", ["p", "ie"].join(""));
  expect(bad.status).toBe(400);
  const badBody = (await bad.json()) as { errors: { path: string; message: string }[] };
  expect(badBody.errors.some((error) => error.path.includes("/report/chart"))).toBe(true);
  // **2値と、書かない形は今日も 201 で通る。**
  expect((await post("c53-bar", "bar")).status).toBe(201);
  expect((await post("c53-line", "line")).status).toBe(201);
  expect((await post("c53-none", undefined)).status).toBe(201);
});

test("(54) 既存3分岐(list_view / form / detail_view)に chart は書けない —— chart: false の行は1行も無く、report: false が隠している", () => {
  const raw = readFileSync(new URL("../../schemas/manifest.schema.json", import.meta.url), "utf-8");
  const schema = JSON.parse(raw) as { $defs: Any };
  const branches = (schema.$defs.view as { allOf: { if: Any; then: { properties: Any } }[] }).allOf;
  /*
   * **【枝番 戊5。限定の字面と実装の形が違うことを、ここで機械的に示す】**
   *
   * **`ADR-0007` の台帳が `Q-G23` に課した限定2 の字面は「既存3分岐では `false`」である。**
   * **今日の実装にはその字面どおりの行が1行も無い** —— **`chart` を `$defs/report` の中に
   * 置いた(決定1)ので、3分岐は `report` そのものを `false` に閉じており、
   * `chart` はその内側に隠れるからである。**
   * **`report` が書けない画面では、`report.chart` も構造的に書けない。**
   */
  for (const type of ["list_view", "form", "detail_view"]) {
    const branch = branches.find(
      (candidate) =>
        ((candidate.if as { properties?: Any }).properties?.type as { const?: string } | undefined)
          ?.const === type,
    );
    expect(branch, type).toBeDefined();
    // **閉じているのは `report` である。**
    expect(branch?.then.properties.report, type).toBe(false);
    // **`chart` という名前の行は、この分岐に1つも無い。**
    expect(Object.keys(branch?.then.properties ?? {}), type).not.toContain("chart");
  }
  // **スキーマ全体でも `"chart": false` は1行も無い**(3分岐の外にも書いていない)。
  expect(raw.includes('"chart": false')).toBe(false);
  expect(raw.includes('"chart":false')).toBe(false);
  // **適用でも同じである** —— **一覧に `chart` つきの `report` を書くと拒否される。**
  expect(
    rejected(
      withViews([
        {
          id: "bad-list-chart",
          type: "list_view",
          table: "sale",
          columns: ["title"],
          report: { ...BASE_REPORT, chart: "bar" },
        },
      ]),
    ).length,
  ).toBeGreaterThan(0);
});

test("(55) chart の $comment と description に、書けない5種の英語綴りが1文字も無い(枝番 庚6)", () => {
  const schema = JSON.parse(
    readFileSync(new URL("../../schemas/manifest.schema.json", import.meta.url), "utf-8"),
  ) as { $defs: Any };
  const chart = (schema.$defs.report as { properties: Any }).properties.chart as {
    $comment: string;
    description: string;
  };
  /*
   * **【この検査自身に、その5語を1文字も綴っていない】** ——
   * **判定する側の文字列を分割して組み立てている。**
   * **綴ってしまうと、同じ数え方(`docs/plan/v8/records/v8-m12.md` §5-3 の
   * `git diff -- schemas/ | grep -ciE ...`)を将来この検査に当てたときに、
   * 検査自身が非0の原因になる。**
   *
   * **なぜ日本語で書くのか**: **`stacked` は今日すでに `manifest.schema.json` の別の場所に
   * 正当な `enum` 値(`inline` / `stacked`)として在り、`$comment` に英語で
   * 「積み上げを書けない」と添えた瞬間に、その数え方が非0になる。**
   * **`$comment` / `description` は日本語で「円・散布図・積み上げ・ドーナツ・面」と書く。**
   */
  const forbidden = [
    ["p", "ie"],
    ["scat", "ter"],
    ["stac", "ked"],
    ["don", "ut"],
    ["ar", "ea"],
  ].map((parts) => parts.join(""));
  // **走査の網が空でないことを先に示す**(0件を走査して0件と言わない)。
  expect(chart.$comment.length).toBeGreaterThan(200);
  expect(chart.description.length).toBeGreaterThan(20);
  for (const word of forbidden) {
    expect(chart.$comment.toLowerCase().includes(word), word).toBe(false);
    expect(chart.description.toLowerCase().includes(word), word).toBe(false);
  }
  // **2値そのものは、値域として今日も書いてある**(閉じすぎていないことの対照)。
  expect(chart.description.includes("bar")).toBe(true);
  expect(chart.description.includes("line")).toBe(true);
});

test("(56) chart は update_view でも運ばれ、落とせば適用後に消える(全置換。diff.schema.json に chart 専用のキーは1本も無い)", async () => {
  /*
   * **【メインの裁定(2026-08-15)による追加。`V8-M12-T02`】**
   *
   * **`$defs/report.properties.chart` の `$comment` が「`update_view` の `report` は
   * 全置換なので、グラフ種別だけを差し替えるキーが1本も要らない」と主張している。**
   * **その主張を見張る歯がどこにも無いと、`ADR-0076` の `writable_by` /
   * `ADR-0080` の `representative_field` が作った『キーは在るが効かない』穴と、
   * 『書いた時点では真だが、誰も見張っていないので静かに偽になる』型を踏む。**
   *
   * **「valid が返った」で終わらせない** —— **適用後のマニフェストの値そのものを読む。**
   */
  const cookie = owner("c56");
  const post = async (diffId: string, operations: unknown[]) =>
    await req(cookie, "POST", `/api/apps/${APP_ID}/diffs`, {
      diff_id: diffId,
      intent: "グラフ種別が update_view でも運ばれることを確かめる",
      operations,
    });
  /*
   * **適用後のマニフェストを、製品自身の読取口(`GET /api/apps/<app_id>/manifest`)から読む。**
   * **カーネルの `readCurrentManifest` を値として `import` しない** ——
   * **`ADR-0009` 限定2 の層またぎ台帳(`scripts/kernel-import-snapshot.txt`)に
   * 1行足すことになり、本タスクの射程の外だからである**(実測: 一度 `import` して
   * `scripts/kernel-import-drift.test.ts` を赤にした)。
   * **HTTP から読むほうが、`add_view` / `update_view` と同じ経路で確かめられる。**
   */
  const chartOf = async (viewId: string): Promise<unknown> => {
    const res = await req(cookie, "GET", `/api/apps/${APP_ID}/manifest`);
    expect(res.status).toBe(200);
    const manifest = (await res.json()) as {
      app: { views: { id: string; report?: { chart?: unknown } }[] };
    };
    return manifest.app.views.find((view) => view.id === viewId)?.report?.chart;
  };
  const baseReport = {
    group_by: [{ field: "category" }],
    aggregates: [{ type: "count" }],
  };
  // **(1) `chart` を1バイトも書かない集計表を作る。**
  expect(
    (
      await post("d56-add", [
        {
          op: "add_view",
          view: { id: "c56", type: "report_view", table: "sale", report: baseReport },
        },
      ])
    ).status,
  ).toBe(201);
  expect(await chartOf("c56")).toBeUndefined();
  // **(2)(3) `update_view` で `report` を全置換し、`chart` を後から入れる。**
  expect(
    (
      await post("d56-set", [
        { op: "update_view", view: "c56", changes: { report: { ...baseReport, chart: "line" } } },
      ])
    ).status,
  ).toBe(201);
  // **適用後のマニフェストに実際に載っている**(受理されただけでは足りない)。
  expect(await chartOf("c56")).toBe("line");
  // **もう一方の値にも差し替えられる。**
  expect(
    (
      await post("d56-swap", [
        { op: "update_view", view: "c56", changes: { report: { ...baseReport, chart: "bar" } } },
      ])
    ).status,
  ).toBe(201);
  expect(await chartOf("c56")).toBe("bar");
  /*
   * **(4) 全置換であることの裏** —— **`chart` を書かない `report` を当て直すと、
   * 適用後に `chart` が消える。**
   * **【`chart` を1本ずつ消す手段は1つも無い】** —— **消えるのは「`report` ごと
   * 書き換えたから」であって、`chart` を外す op が在るからではない。**
   */
  expect(
    (
      await post("d56-drop", [
        { op: "update_view", view: "c56", changes: { report: { ...baseReport } } },
      ])
    ).status,
  ).toBe(201);
  expect(await chartOf("c56")).toBeUndefined();
  /*
   * **(5) `schemas/diff.schema.json` に `chart` 専用のキーが1本も無い。**
   * **`view_changes.properties` が 25 のままであることは (50) が見ている。**
   * **ここでは生ファイルに `chart` という文字列が1件も無いことを見る** ——
   * **キーとしても `$comment` の中の言及としても、差分の語彙に持ち込んでいない。**
   * **値域の定義は `manifest` 側の `$ref` 1本だけを通って届く。**
   */
  const rawDiffSchema = readFileSync(
    new URL("../../schemas/diff.schema.json", import.meta.url),
    "utf-8",
  );
  // **走査の網が空でないことを先に示す**(0件を走査して0件と言わない)。
  expect(rawDiffSchema.length).toBeGreaterThan(1000);
  expect(rawDiffSchema.includes("report")).toBe(true);
  expect(rawDiffSchema.toLowerCase().includes("chart")).toBe(false);
});
