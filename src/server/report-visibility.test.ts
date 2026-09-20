/**
 * **集計表は「その人に見える行」だけを数える**(`V8-M10-T03`。台帳 `Q-G13` / `Q-G15`。
 * ユーザ決定 `D-V8-127` / `D-V8-128`)。
 *
 * **審査の正は `docs/plan/v8/records/v8-m7.md`**、**実施の正は
 * `docs/plan/v8/records/v8-m10.md` §1 の `T03` と §1-0c の決定10件**である。
 *
 * ## ここで測るもの(**本物の SQLite / 本物の HTTP**)
 *
 * | 群 | 何を |
 * |---|---|
 * | (A) | **同じ集計表を2人が開くと違う数が出る**(`Q-G13`)。**5分岐を1つずつ別々に** |
 * | (B) | **群ごとの件数の和が、その人の可視件数と一致する**(`Q-G15`)。**2人ぶん別々に** |
 * | (C) | **読める行が1行も無い人には、合計0・件数0を 200 で返す**(`D-V8-128`) |
 * | (D) | **白箱** —— **判定は `src/kernel/report.ts` の中に1文字も無い**(§1-0c の決定1) |
 * | (E) | **結合の向こう側にも効く**(`V8-M10-T04` / `Q-G14`)。**起点は分岐5・結合先は分岐3** |
 *
 * ## 【正直に書く】この検査が言わないこと
 *
 * 1. **結合先の表の可視性を1ミリも測っていない** —— **`T03` は起点の表だけに掛ける。**
 *    **結合先は `T04`(`Q-G14`)である。** **今日の実装は、起点の表以外の読取を
 *    そのまま通す**((D-2) がそのことを固定している)。
 *    **【`V8-M10-T04` による訂正。上の3行を1バイトも消していない】** ——
 *    **今日は結合先の表にも同じ注入が当たる。** **(D-2) は「起点だけを通す1行が外れた」を
 *    数える側へ反転した。** **振る舞いの実測は
 *    `src/server/report-join-boundary.test.ts` の (23)(30)〜(34) にある**
 *    (**題材に結合が要るので、そちらに置いた**)。
 * 2. **分岐1(匿名公開)の集計を1度も見ていない** —— **見られない。**
 *    **集計表の経路は未ログインを 401 で閉じる**(`D-V8-127`。**本マイルストーンは
 *    この窓を開けない**)。**(A-6) は「401 であること」までしか測っていない。**
 * 3. **上限(群化前に読む行数・作る群の数)を1つも測っていない** —— **`T05` である。**
 * 4. **性能を1度も測っていない** —— **`T07` である。**
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appDbPath,
  applyManifest,
  createApp,
  createRecord,
  KernelMetaStore,
  type Manifest,
} from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN } from "./test-helpers.ts";

const APP_ID = "report-visibility";

type Any = Record<string, unknown>;

/**
 * **題材は `v8-m10.md` §2-6 の台(アプリ `m10-branch`)と同じ形である** ——
 * **読取の5分岐を1表ずつ踏み分ける。** **実 HTTP の実測(§4)と、この検査が
 * 同じ題材を見ていることに意味がある**(数が食い違ったらどちらかが嘘である)。
 */
const COMMON_FIELDS: Any[] = [
  { id: "title", name: "件名", type: "text", required: true },
  { id: "amount", name: "金額", type: "number" },
  { id: "tag", name: "区分", type: "select", options: ["A", "B"] },
];

const PERMISSIONS: Any[] = [
  { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
  { id: "writer", name: "編集できる", read: true, write: true, delete: false },
];

function tables(): Any[] {
  return [
    // 分岐1: 匿名公開(`st_public`)。**ログイン済の要求は分岐5に落ちる**(§2-6 の1)。
    {
      id: "t_public",
      name: "公開表",
      fields: [...COMMON_FIELDS, { id: "st_public", name: "公開", type: "boolean" }],
    },
    // 分岐2: 個人スコープ(`st_owner`)。
    {
      id: "t_owner",
      name: "個人所有表",
      fields: [...COMMON_FIELDS, { id: "st_owner", name: "持ち主", type: "text" }],
    },
    // 分岐3: 行ごとのアクセス権。
    {
      id: "t_grant",
      name: "行アクセス権表",
      fields: COMMON_FIELDS,
      access_control: {
        enabled: true,
        permissions: PERMISSIONS,
        creator_permission: "writer",
        grant: {
          table: "t_grant_grant",
          target: "row",
          member: "member",
          permission: "permission",
        },
        members: { table: "t_grant_member", account: "account" },
      },
    },
    // 分岐4: 条件つきの読取規則だけが立っている表。
    {
      id: "t_cond",
      name: "条件読取表",
      fields: [...COMMON_FIELDS, { id: "handler", name: "担当", type: "text" }],
    },
    // 分岐5: 何も宣言していない表。
    { id: "t_plain", name: "非スコープ表", fields: COMMON_FIELDS },
    /*
     * **【`V8-M10-T04` / `Q-G14` が足した表】** **起点が分岐5(絞り不要)で、
     * 結合先が分岐3(行ごとのアクセス権)になる形を作るための表である。**
     * **起点の判定を結合先に流用すると、この形で付与を1件も持たない人にも
     * 全行が数えられる** —— **表ごとに引き直していることの実測台。**
     */
    {
      id: "t_ref",
      name: "参照元表",
      fields: [
        { id: "label", name: "見出し", type: "text", required: true },
        { id: "link", name: "参照先", type: "reference", reference_table: "t_grant" },
      ],
    },
    // --- 分岐3 の土台 ---
    {
      id: "t_grant_member",
      name: "利用者",
      fields: [{ id: "account", name: "ログイン", type: "text" }],
    },
    {
      id: "t_grant_grant",
      name: "付与",
      fields: [
        { id: "row", name: "行", type: "reference", reference_table: "t_grant" },
        { id: "member", name: "相手", type: "reference", reference_table: "t_grant_member" },
        { id: "permission", name: "権限", type: "select", options: ["reader", "writer"] },
      ],
    },
  ];
}

const BRANCH_TABLES = ["t_public", "t_owner", "t_grant", "t_cond", "t_plain"] as const;
const SUPPORT_TABLES = ["t_grant_member", "t_grant_grant"] as const;

/** 5表それぞれに「区分ごとの合計と件数」の集計表を1枚ずつ。 */
function views(): Any[] {
  return [
    ...BRANCH_TABLES.map((table) => ({
      id: `rep_${table}`,
      type: "report_view",
      table,
      name: `${table} の集計`,
      report: {
        group_by: [{ field: "tag" }],
        aggregates: [{ type: "sum", field: "amount" }, { type: "count" }],
      },
    })),
    /*
     * **【`V8-M10-T04` / `Q-G14`】起点は分岐5(絞り不要)、結合先は分岐3(行ごとの
     * アクセス権)。** **順方向(子 → 親)なので、見えない親は `null` に倒れる。**
     */
    {
      id: "rep_join_grant",
      type: "report_view",
      table: "t_ref",
      name: "参照元 → 行アクセス権表",
      report: {
        join: [{ table: "t_ref", via: "link" }],
        group_by: [{ table: "t_grant", field: "tag" }],
        aggregates: [
          { type: "sum", table: "t_grant", field: "amount" },
          { type: "count", table: "t_grant" },
        ],
      },
    },
  ];
}

function roles(): Any[] {
  const viewRules = views().map((view) => ({ target: "view", view: view.id, can: ["read"] }));
  return [
    {
      id: "owner",
      name: "持ち主",
      rules: [
        { target: "app", can: ["write"] },
        { target: "role", can: ["write"] },
        { target: "table", table: "t_public", can: ["read", "write", "delete"] },
        // **無条件の読取** —— **持ち主スコープを越えて全行が見える**(`D-V8-35`)。
        { target: "table", table: "t_owner", can: ["read", "write", "delete"] },
        // 分岐4: 条件つきの読取だけ(`conditional: true`)。
        {
          target: "table",
          table: "t_cond",
          can: ["read"],
          when: { field: "handler", equals_current_user: true },
        },
        { target: "table", table: "t_cond", can: ["write", "delete"] },
        { target: "table", table: "t_plain", can: ["read", "write", "delete"] },
        // **【`V8-M10-T04`】起点は絞り不要**(結合先の `t_grant` だけが分岐3)。
        { target: "table", table: "t_ref", can: ["read", "write", "delete"] },
        ...SUPPORT_TABLES.map((table) => ({
          target: "table",
          table,
          can: ["read", "write", "delete"],
        })),
        ...viewRules,
      ],
    },
    {
      id: "editor",
      name: "係",
      rules: [
        { target: "table", table: "t_public", can: ["read"] },
        // 分岐2: 条件つき → 自分の行だけ。
        {
          target: "table",
          table: "t_owner",
          can: ["read"],
          when: { field: "st_owner", equals_current_user: true },
        },
        // 分岐4: 区分 A だけ。
        { target: "table", table: "t_cond", can: ["read"], when: { field: "tag", equals: "A" } },
        { target: "table", table: "t_plain", can: ["read"] },
        { target: "table", table: "t_ref", can: ["read"] },
        ...viewRules,
      ],
    },
    // **規則を1本も持たない役割**(`D-V8-128` の当たり先)。
    // **画面の規則だけは持たせる** —— **持たせないと画面の関門で 403 になり、
    // 「読める行が0件の人に 200 が返る」を測れない。**
    { id: "viewer", name: "通りすがり", rules: viewRules },
    { id: "customer", name: "客", rules: viewRules },
    // **未ログインが一覧で公開行を読めることの対照**((A-6) が使う)。
    // **【`V18-M4-T02b`。ユーザ決定 `D-V18-26` / `ADR-0441`】画面の規則を足した。**
    //
    // **`V18-M4-T02` が「画面名を名乗らない読取」に壁を立てた** —— **その表を指す一覧系の
    // 画面(`list_view` / `report_view`)を**1本も読めない**相手の一覧は 0件になる
    // (単票の口は `detail_view` / `form` を見て 404 になる)。** **`D-V18-26` により、
    // 画面を宣言しているのに「誰に見せるか」を役割の規則に1行も書いていない場合も止まる。**
    //
    // **`anonymous` にだけ画面の規則が1本も無かった** —— **(A-6) の対照
    // (「一覧のほうは今日も匿名に開いている」)が `total: 6` → `0` になっていた。**
    // **本ファイルの主題は集計表の可視性であって画面の規則ではないので、
    // 主張(`expect`)は1バイトも書き換えていない。**
    // **配るのは他の役割と同じ `viewRules`(全画面 × 読取)である。**
    {
      id: "anonymous",
      name: "未ログイン",
      rules: [{ target: "table", table: "t_public", can: ["read"] }, ...viewRules],
    },
  ];
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;
let u1: ReturnType<typeof seedSession>;
let u2: ReturnType<typeof seedSession>;
let u3: ReturnType<typeof seedSession>;
let manifest: Manifest;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-report-visibility-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "集計表の可視性", { app_id: APP_ID });
  } finally {
    store.close();
  }
  // 利用者を先に作る(条件つき規則の「自分」に実IDが要る)。
  u1 = seedSession(dataRoot, APP_ID, { role: "owner", username: "u1-owner" });
  u2 = seedSession(dataRoot, APP_ID, { role: "editor", username: "u2-staff" });
  u3 = seedSession(dataRoot, APP_ID, { role: "viewer", username: "u3-guest" });

  const applied = applyManifest(dataRoot, APP_ID, {
    app: {
      id: APP_ID,
      name: "集計表の可視性",
      tables: tables(),
      views: views(),
      roles: roles(),
    },
  } as unknown as Manifest);
  expect(
    applied.valid,
    applied.valid ? "" : JSON.stringify((applied as { errors: unknown }).errors),
  ).toBe(true);
  manifest = (applied as { manifest: Manifest }).manifest;

  // --- 各表10行(`v8-m10.md` §2-6 の台と同じ配り方)---------------------------------
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  const created: Record<string, string[]> = {};
  const add = (table: string, input: Any): string => {
    const result = createRecord(db, manifest, table, input);
    expect(result.ok, result.ok ? "" : JSON.stringify((result as { errors: unknown }).errors)).toBe(
      true,
    );
    const id = (result as { value: { _id: string } }).value._id;
    const bucket = created[table] ?? [];
    bucket.push(id);
    created[table] = bucket;
    return id;
  };
  try {
    for (let i = 0; i < 10; i += 1) {
      const tag = i % 2 === 0 ? "A" : "B";
      const amount = (i + 1) * 100;
      add("t_public", { title: `公開${i}`, amount, tag, st_public: i < 6 });
      // 4行 u1 / 3行 u2 / 3行 共有(空文字)。
      add("t_owner", {
        title: `個人${i}`,
        amount,
        tag,
        st_owner: i < 4 ? u1.userId : i < 7 ? u2.userId : "",
      });
      add("t_grant", { title: `付与対象${i}`, amount, tag });
      // 3行 u1 / 3行 u2 / 4行 他人。
      add("t_cond", {
        title: `条件${i}`,
        amount,
        tag,
        handler: i < 3 ? u1.userId : i < 6 ? u2.userId : "someone-else",
      });
      add("t_plain", { title: `素${i}`, amount, tag });
    }
    // 付与: u1 に4件 / u2 に3件 / u3 に0件。
    const members: Record<string, string> = {};
    for (const [key, user] of [
      ["u1", u1],
      ["u2", u2],
      ["u3", u3],
    ] as const) {
      members[key] = add("t_grant_member", { account: user.userId });
    }
    const rows = created.t_grant ?? [];
    for (let i = 0; i < 4; i += 1) {
      add("t_grant_grant", { row: rows[i], member: members.u1, permission: "reader" });
    }
    for (let i = 4; i < 7; i += 1) {
      add("t_grant_grant", { row: rows[i], member: members.u2, permission: "reader" });
    }
    // **【`V8-M10-T04`】参照元は `t_grant` の10行に1対1で結び付く**(誰でも全10行読める)。
    for (const [index, row] of rows.entries()) {
      add("t_ref", { label: `参照${index}`, link: row });
    }
  } finally {
    db.close();
  }

  app = createServerApp({ dataRoot });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function req(cookie: string | undefined, method: string, path: string) {
  const headers: Record<string, string> = { origin: TEST_ORIGIN };
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  return Promise.resolve(app.request(new Request(`http://localhost${path}`, { method, headers })));
}

type ReportAggregate = { type: string; field?: string; value: number };
type ReportBody = {
  groups: { keys: { field: string; value: unknown }[]; aggregates: ReportAggregate[] }[];
  total_groups: number;
  totals: ReportAggregate[];
};

async function readReport(
  cookie: string | undefined,
  table: string,
): Promise<{ status: number; body: ReportBody }> {
  const res = await req(cookie, "GET", `/api/apps/${APP_ID}/views/rep_${table}/report`);
  return { status: res.status, body: (await res.json()) as ReportBody };
}

/** その人が一覧で読める件数(**可視性の post-filter を通した後・群化の前の行数**)。 */
async function visibleCount(cookie: string, table: string): Promise<number> {
  const res = await req(cookie, "GET", `/api/apps/${APP_ID}/tables/${table}/records`);
  expect(res.status, table).toBe(200);
  return ((await res.json()) as { total: number }).total;
}

function countOf(body: ReportBody): number {
  return body.totals.find((aggregate) => aggregate.type === "count")?.value ?? -1;
}

function sumOf(body: ReportBody): number {
  return body.totals.find((aggregate) => aggregate.type === "sum")?.value ?? -1;
}

/** 群ごとの件数の和(`Q-G15`)。 */
function summedGroupCounts(body: ReportBody): number {
  return body.groups.reduce(
    (acc, group) => acc + (group.aggregates.find((a) => a.type === "count")?.value ?? 0),
    0,
  );
}

// =====================================================================================
// (A) 同じ集計表を2人が開くと違う数が出る(`Q-G13`)
// =====================================================================================

test("(A-1) 同じ集計表を2人が開くと違う数が出る(着手前は3人とも1バイト同一だった)", async () => {
  const forOwner = await readReport(u1.cookie, "t_owner");
  const forStaff = await readReport(u2.cookie, "t_owner");
  expect(forOwner.status).toBe(200);
  expect(forStaff.status).toBe(200);
  // **持ち主は無条件の読取を持つので全10行**、**係は自分の3行だけ。**
  expect(countOf(forOwner.body)).toBe(10);
  expect(countOf(forStaff.body)).toBe(3);
  // **応答本文そのものが違う**(着手前はここが `toBe` で一致していた)。
  expect(JSON.stringify(forStaff.body)).not.toBe(JSON.stringify(forOwner.body));
});

test("(A-2) 分岐2(個人スコープ `st_owner`): 見えない行は合計にも件数にも入らない", async () => {
  const forStaff = await readReport(u2.cookie, "t_owner");
  expect(countOf(forStaff.body)).toBe(await visibleCount(u2.cookie, "t_owner"));
  // **母集団が10行なら 5500。** **係の3行ぶんだけが足される。**
  expect(sumOf(forStaff.body)).toBeLessThan(5500);
});

test("(A-3) 分岐3(行ごとのアクセス権): 付与された行だけが数えられる", async () => {
  const forOwner = await readReport(u1.cookie, "t_grant");
  const forStaff = await readReport(u2.cookie, "t_grant");
  expect(countOf(forOwner.body)).toBe(4);
  expect(countOf(forStaff.body)).toBe(3);
});

test("(A-4) 分岐4(条件つきの読取規則だけの表): 条件を満たす行だけが数えられる", async () => {
  const forOwner = await readReport(u1.cookie, "t_cond");
  const forStaff = await readReport(u2.cookie, "t_cond");
  // 持ち主は「担当が自分」の3行、係は「区分 A」の5行。
  expect(countOf(forOwner.body)).toBe(3);
  expect(countOf(forStaff.body)).toBe(5);
});

test("(A-5) 分岐5(非スコープ): 絞りが要らない表では2人とも全行を数える(閉じすぎていない)", async () => {
  const forOwner = await readReport(u1.cookie, "t_plain");
  const forStaff = await readReport(u2.cookie, "t_plain");
  expect(countOf(forOwner.body)).toBe(10);
  expect(countOf(forStaff.body)).toBe(10);
  expect(JSON.stringify(forStaff.body)).toBe(JSON.stringify(forOwner.body));
});

test("(A-6) 分岐1(匿名公開)は集計表の経路では 401 である(D-V8-127。窓を開けない)", async () => {
  const res = await req(undefined, "GET", `/api/apps/${APP_ID}/views/rep_t_public/report`);
  expect(res.status).toBe(401);
  // **一覧のほうは今日も匿名に開いている**(食い違いが残ることを、ここで名指しする)。
  const list = await req(undefined, "GET", `/api/apps/${APP_ID}/tables/t_public/records`);
  expect(list.status).toBe(200);
  expect(((await list.json()) as { total: number }).total).toBe(6);
});

// =====================================================================================
// (B) 群ごとの件数の和 = その人の可視件数(`Q-G15`)
// =====================================================================================

test("(B-1) 群ごとの件数の和が、その人の可視件数と一致する(持ち主)", async () => {
  for (const table of ["t_owner", "t_grant", "t_cond", "t_plain"] as const) {
    const { body } = await readReport(u1.cookie, table);
    const visible = await visibleCount(u1.cookie, table);
    // **各群が件数を持つ**(1つでも欠けたら和は合わない)。
    for (const group of body.groups) {
      expect(
        group.aggregates.some((aggregate) => aggregate.type === "count"),
        table,
      ).toBe(true);
    }
    expect({ table, summed: summedGroupCounts(body) }).toEqual({ table, summed: visible });
    expect({ table, total: countOf(body) }).toEqual({ table, total: visible });
  }
});

test("(B-2) 群ごとの件数の和が、その人の可視件数と一致する(係。持ち主とは数が違う)", async () => {
  const seen: Record<string, number> = {};
  for (const table of ["t_owner", "t_grant", "t_cond", "t_plain"] as const) {
    const { body } = await readReport(u2.cookie, table);
    const visible = await visibleCount(u2.cookie, table);
    for (const group of body.groups) {
      expect(
        group.aggregates.some((aggregate) => aggregate.type === "count"),
        table,
      ).toBe(true);
    }
    expect({ table, summed: summedGroupCounts(body) }).toEqual({ table, summed: visible });
    seen[table] = visible;
  }
  // **2人ぶんが同じ数ではないこと**(同じなら「一致した」と言えても意味が無い)。
  expect(seen.t_owner).toBe(3);
  expect(seen.t_grant).toBe(3);
  expect(seen.t_cond).toBe(5);
});

// =====================================================================================
// (C) 読める行が1行も無い人(`D-V8-128`)
// =====================================================================================

test("(C-1) 規則を1本も持たない人には、合計0・件数0の集計が 200 で返る(403 にしない)", async () => {
  for (const table of ["t_public", "t_owner", "t_cond", "t_plain"] as const) {
    const { status, body } = await readReport(u3.cookie, table);
    expect({ table, status }).toEqual({ table, status: 200 });
    expect({ table, groups: body.groups, total_groups: body.total_groups }).toEqual({
      table,
      groups: [],
      total_groups: 0,
    });
    expect({ table, totals: body.totals }).toEqual({
      table,
      totals: [
        { type: "sum", field: "amount", value: 0 },
        { type: "count", value: 0 },
      ],
    });
  }
});

test("(C-2) 付与が1件も無い人の0件は、手前の関門ではなく分岐3の中身の結果である", async () => {
  // **`t_grant` は行ごとの付与を宣言しているので、面の関門(`roleGateBlocksWithoutGrants`)は
  // ここで止めない**(`D-V8-23` の `OR`)。**0件になるのは、付与が1件も無いからである。**
  const { status, body } = await readReport(u3.cookie, "t_grant");
  expect(status).toBe(200);
  expect(countOf(body)).toBe(0);
  expect(await visibleCount(u3.cookie, "t_grant")).toBe(0);
});

// =====================================================================================
// (D) 白箱(§1-0c の決定1)
// =====================================================================================

test("(D-1) 判定は src/kernel/report.ts の中に1文字も無い(注入だけを受け取る)", async () => {
  const source = await Bun.file(new URL("../kernel/report.ts", import.meta.url)).text();
  const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
  for (const symbol of [
    "judgeRoleAccess",
    "projectForRoleFields",
    "st_owner",
    "st_public",
    "owner-scope",
    "judgeRecordPopulation",
    "recordAccessJudge",
  ]) {
    expect(
      code.filter((line) => line.includes(symbol)),
      symbol,
    ).toEqual([]);
  }
  // **受け取っているのは注入1つだけである**(`visibleRows`)。
  expect(code.filter((line) => line.includes("visibleRows")).length).toBeGreaterThan(0);
});

/*
 * **【`V8-M10-T04`(台帳 `Q-G14`)による反転。旧テスト名と旧の期待値を逐語で残す】**
 *
 * **旧テスト名(逐語)**:
 *   `(D-2) 起点の表だけに掛かっている(結合先は T04 の担当。今日は素通しである)`
 * **旧の期待値(逐語)**:
 *   `expect(source).toContain("readTableId !== view.table");`
 *   (**コメント**: 「**`T04` がここを外すまで、起点の表以外は素通しである。** **逐語で固定する。**」)
 *
 * **`T04` はその1行を外した** —— **注入は表ごとに判定を引き直す。**
 *
 * **【`T02` / `T03` が2度当たった落とし穴に手当てしてある】** ——
 * **旧の逐語(`readTableId !== view.table`)は `app.ts` の注釈にも残してある**
 * (作法として消さないため)。**素の `toContain` で数えると、その注釈を読んで
 * 緑のまま残る。** **したがって本検査は注釈行を落としてから数える**
 * (この行を消すと、検査は生まれた時点で偽になる)。
 */
test("(D-2) 結合先の表にも掛かっている(起点だけを通す1行は外れた)", async () => {
  const source = await Bun.file(new URL("./app.ts", import.meta.url)).text();
  const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
  // **実コードには1行も無い**(注釈には逐語で残っている)。
  expect(code.filter((line) => line.includes("readTableId !== view.table"))).toEqual([]);
  // **注釈のほうには残っている**(消していないことの担保。**残置が上を緑にしていない**)。
  expect(source).toContain("readTableId !== view.table");
  // **表ごとに引き直していること** —— **判定の4つを `readTableId` で引く1本が在る。**
  expect(code.filter((line) => line.includes("visibleRowsOf(")).length).toBeGreaterThan(0);
});

// =====================================================================================
// (E) **結合の向こう側にも効く**(`V8-M10-T04`。台帳 `Q-G14`)
//
// **起点は分岐5(絞りが要らない表)、結合先は分岐3(行ごとのアクセス権)である** ——
// **起点の判定を結合先に流用していたら、この形は誰にも全行が見える。**
// =====================================================================================

/** 結合した集計を読む(起点 = `t_ref`)。 */
async function readJoinReport(cookie: string): Promise<{ status: number; body: ReportBody }> {
  const res = await req(cookie, "GET", `/api/apps/${APP_ID}/views/rep_join_grant/report`);
  return { status: res.status, body: (await res.json()) as ReportBody };
}

/** 群を「キーの値 → 集計値の並び」へ潰す。 */
function shapeOf(body: ReportBody): [unknown, number[]][] {
  return body.groups.map((group) => [
    group.keys[0]?.value ?? null,
    group.aggregates.map((aggregate) => aggregate.value),
  ]);
}

test("(E-1) 結合先が分岐3(行ごとのアクセス権)のとき、付与された相手だけが数えられる", async () => {
  // **持ち主は4件の付与を持つ** —— **区分 A は行0と行2(100 + 300)、B は行1と行3。**
  const forOwner = await readJoinReport(u1.cookie);
  expect(forOwner.status).toBe(200);
  expect(shapeOf(forOwner.body)).toEqual([
    ["A", [400, 2]],
    ["B", [600, 2]],
    // **見えない相手を持つ参照元6行は、`null` の群に1行ずつ残る**(**落としていない**)。
    [null, [0, 0]],
  ]);

  // **係は3件の付与を持つ** —— **行4(A/500)・行5(B/600)・行6(A/700)。**
  const forStaff = await readJoinReport(u2.cookie);
  expect(shapeOf(forStaff.body)).toEqual([
    ["A", [1200, 2]],
    ["B", [600, 1]],
    [null, [0, 0]],
  ]);

  // **【実測。見立てと違ったので、そのまま書く】** **`u3`(規則を1本も持たない役割)は
  // 起点の `t_ref` そのものが読めない** —— **群は `null` の1つではなく、0個である。**
  // **結合先が見えないから 0 なのではなく、起点で止まっているからである**
  // (**この2つは応答の上で区別できない。`T03` §4-4 の3 と同じ穴が、結合でも在る**)。
  const forGuest = await readJoinReport(u3.cookie);
  expect(forGuest.status).toBe(200);
  expect(shapeOf(forGuest.body)).toEqual([]);
  expect(forGuest.body.totals).toEqual([
    { type: "sum", field: "amount", value: 0 },
    { type: "count", value: 0 },
  ]);
});

test("(E-2) 結合先が見えなくても起点の行は1行も落ちない(群の件数の和ではなく、行の数で測る)", async () => {
  // **起点(`t_ref`)を読める2人で測る** —— **`u3` は起点そのものが閉じているので、
  // 「結合先が見えないから落ちた」を測る台にならない**((E-1) にその実測を書いた)。
  for (const [label, cookie] of [
    ["u1", u1.cookie],
    ["u2", u2.cookie],
  ] as const) {
    const { body } = await readJoinReport(cookie);
    // **`t_ref` の行数は2人とも 10 である。**
    expect({ label, rows: await visibleCount(cookie, "t_ref") }).toEqual({ label, rows: 10 });
    // **`count` は「相手が結び付いている行」の数なので、和は可視の付与の数になる** ——
    // **`u1` は 4 / `u2` は 3。** **群の数は3つ(A / B / 相手が無い)で同じ。**
    const summed = body.groups.reduce(
      (acc, group) => acc + (group.aggregates.find((a) => a.type === "count")?.value ?? 0),
      0,
    );
    expect({ label, summed }).toEqual({ label, summed: label === "u1" ? 4 : 3 });
    expect({ label, groups: body.total_groups }).toEqual({ label, groups: 3 });
  }
});
