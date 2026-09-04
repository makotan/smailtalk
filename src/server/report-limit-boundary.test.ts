/**
 * **集計表が上限に当たったときの止め方**(`V8-M10-T05`。台帳 `Q-G17` / `Q-G18` / `Q-G19`。
 * 裁定 `M7-1` + ユーザ決定 `D-V8-124`。`v8-m10.md` §1-0c の決定2 / 決定3 / 決定4)。
 *
 * **審査の正は `docs/plan/v8/records/v8-m7.md`**、**実施の正は
 * `docs/plan/v8/records/v8-m10.md` §1 の `T05` と §1-0c の決定10件**である。
 *
 * ## 上限の実数(**4値。ここで測るのは後ろ2つ**)
 *
 * | 上限 | 値 | いつ当たるか |
 * |---|---:|---|
 * | 結合する表の本数(起点を含む) | **5** | **apply 時**(`V8-M9`) |
 * | 段数 | **3** | **apply 時**(`V8-M9`) |
 * | **群にまとめる前に読む行の件数** | **10,000** | **読取時**(本タスク) |
 * | **作る群の数** | **10,000** | **読取時**(本タスク) |
 *
 * **【禁止】この4値を「測って決めた」と書かない** —— **測ったのは読む行数の1つだけである**
 * (`v8-m7.md` §10-3 の2)。
 *
 * ## ここで測るもの(**本物の SQLite / 本物の HTTP**)
 *
 * | 群 | 何を |
 * |---|---|
 * | (A) | **inclusive** —— **上限ちょうどは通り、超えたら 4xx**(§1-0c の決定3) |
 * | (B) | **読む行は表ごとに2箇所で数える**(§1-0c の決定2)。**(i) 可視性の前 / (ii) 後** |
 * | (C) | **上限に当たった応答と、本当に0件の応答が機械的に区別できる**(`D-V8-128`) |
 * | (D) | **上限の種別が6つとも互いに区別できる**(`T05` 完了条件 3') |
 * | (E) | **既存の 1,000(引き継ぎ)と集計表の 10,000 の関係**(`T05` 完了条件 3'') |
 *
 * ## 【正直に書く】この検査が言わないこと
 *
 * 1. **性能を1度も測っていない**(`T07`)。**ここは「止まるかどうか」だけを見る。**
 * 2. **(ii)(可視性の post-filter を通した後の行数)を単独で当てられていない** ——
 *    **(ii) ≤ (i) が構造的に成り立つ**(可視性は行を増やさない)ので、
 *    **(i) が同じ 10,000 で先に返す限り (ii) は発火しない。**
 *    **(B-3) はそのことを述語の側で固定している**(**「両方書いてある」ことと
 *    「(ii) は今日到達しない」ことを同時に書く**)。
 * 3. **結合したあとのファンアウト行数を1度も数えていない**(§1-0c の決定2)——
 *    **止めるのは「作る群の数」のほうである。**
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
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
import { MAX_REPORT_GROUPS, MAX_REPORT_SCANNED_ROWS } from "./report-limits.ts";
import { seedSession, TEST_ORIGIN } from "./test-helpers.ts";

/**
 * 移した公開単位の根(`apps/smailtalk/`)。**`import.meta.dir` から数える** ——
 * cwd 相対で解くと `bun test` を打つ場所で結果が変わる(`src/` はもうルート直下に無い)。
 */
const PRODUCT_ROOT = join(import.meta.dir, "..", "..");

const APP_ID = "report-limit";

type Any = Record<string, unknown>;

const OWNER_BASE: Any[] = [
  { target: "app", can: ["write"] },
  { target: "role", can: ["write"] },
];

/**
 * **題材(1つのアプリに3つの台を同居させる)**
 *
 * - **`t_big`**: **10,001 行**。**読む行の上限(10,000)の台。**
 *   **`st_owner` を持たせてある** —— **持ち主は無条件の読取で全行、係は条件つきで0行。**
 *   **同じ表で「可視0件の人にも (i) が当たる」を測れる**((B-1))。
 * - **`g_parent` / `g_child`**: **親2行 + 子 10,000 行(全部 親#1 にぶら下げる)。**
 *   **逆方向の結合で 10,001 行に膨らみ、行そのもの(`_id`)で束ねると群が 10,001 になる。**
 *   **どちらの表も読む行は 10,000 以下なので、当たるのは「作る群の数」だけである。**
 * - **`i_child` / `i_parent` / `i_grant` …**: **引き継ぎ(`inherit_from`)の台。**
 *   **親の段で読む付与行を 1,001 件にすると、既存の 1,000 が先に落とす。**
 */
function tables(): Any[] {
  return [
    {
      id: "t_big",
      name: "大きい表",
      fields: [
        { id: "title", name: "件名", type: "text", required: true },
        { id: "amount", name: "金額", type: "number" },
        { id: "tag", name: "区分", type: "select", options: ["A", "B"] },
        { id: "st_owner", name: "持ち主", type: "text" },
      ],
    },
    {
      id: "g_parent",
      name: "親",
      fields: [{ id: "label", name: "見出し", type: "text", required: true }],
    },
    {
      id: "g_child",
      name: "子",
      fields: [
        { id: "label", name: "見出し", type: "text", required: true },
        { id: "amount", name: "金額", type: "number" },
        { id: "parent", name: "親", type: "reference", reference_table: "g_parent" },
      ],
    },
    // --- 引き継ぎの台 -------------------------------------------------------------
    {
      id: "i_member",
      name: "利用者",
      fields: [{ id: "account", name: "ログイン", type: "text" }],
    },
    {
      id: "i_parent",
      name: "引き継ぎ元",
      fields: [{ id: "label", name: "見出し", type: "text", required: true }],
      access_control: {
        enabled: true,
        permissions: [{ id: "reader", name: "参照のみ", read: true, write: false, delete: false }],
        creator_permission: "reader",
        grant: {
          table: "i_parent_grant",
          target: "row",
          member: "member",
          permission: "permission",
        },
        members: { table: "i_member", account: "account" },
      },
    },
    {
      id: "i_parent_grant",
      name: "引き継ぎ元の付与",
      fields: [
        { id: "row", name: "行", type: "reference", reference_table: "i_parent" },
        { id: "member", name: "相手", type: "reference", reference_table: "i_member" },
        { id: "permission", name: "権限", type: "select", options: ["reader"] },
      ],
    },
    {
      id: "i_child",
      name: "引き継ぎ先",
      fields: [
        { id: "title", name: "件名", type: "text", required: true },
        { id: "tag", name: "区分", type: "select", options: ["A", "B"] },
        { id: "parent", name: "親", type: "reference", reference_table: "i_parent" },
      ],
      access_control: {
        enabled: true,
        permissions: [{ id: "reader", name: "参照のみ", read: true, write: false, delete: false }],
        creator_permission: "reader",
        grant: {
          table: "i_child_grant",
          target: "row",
          member: "member",
          permission: "permission",
        },
        members: { table: "i_member", account: "account" },
        inherit_from: ["parent"],
      },
    },
    {
      id: "i_child_grant",
      name: "引き継ぎ先の付与",
      fields: [
        { id: "row", name: "行", type: "reference", reference_table: "i_child" },
        { id: "member", name: "相手", type: "reference", reference_table: "i_member" },
        { id: "permission", name: "権限", type: "select", options: ["reader"] },
      ],
    },
    /**
     * **引き継ぎの**段数**の上限(既存の5段)を集計表の口から当てるための表。**
     * **自分自身を親に持てる**(1つの表で鎖を作れるので、7つの表を宣言しなくてよい)。
     */
    {
      id: "d_chain",
      name: "段の鎖",
      fields: [
        { id: "title", name: "件名", type: "text", required: true },
        { id: "tag", name: "区分", type: "select", options: ["A", "B"] },
        { id: "parent", name: "親", type: "reference", reference_table: "d_chain" },
      ],
      access_control: {
        enabled: true,
        permissions: [{ id: "reader", name: "参照のみ", read: true, write: false, delete: false }],
        creator_permission: "reader",
        grant: {
          table: "d_chain_grant",
          target: "row",
          member: "member",
          permission: "permission",
        },
        members: { table: "i_member", account: "account" },
        inherit_from: ["parent"],
      },
    },
    {
      id: "d_chain_grant",
      name: "段の鎖の付与",
      fields: [
        { id: "row", name: "行", type: "reference", reference_table: "d_chain" },
        { id: "member", name: "相手", type: "reference", reference_table: "i_member" },
        { id: "permission", name: "権限", type: "select", options: ["reader"] },
      ],
    },
    /**
     * **行アクセス権を宣言しているが、引き継ぎ(`inherit_from`)を1本も持たない表。**
     * **(E-3) の台** —— **既存の 1,000 は「親の段で読む行」しか数えないので、
     * この形では1度も発火しない。** **集計表の 10,000 のほうが当たる。**
     */
    {
      id: "i_flat",
      name: "付与だけの表",
      fields: [
        { id: "title", name: "件名", type: "text", required: true },
        { id: "tag", name: "区分", type: "select", options: ["A", "B"] },
      ],
      access_control: {
        enabled: true,
        permissions: [{ id: "reader", name: "参照のみ", read: true, write: false, delete: false }],
        creator_permission: "reader",
        grant: {
          table: "i_flat_grant",
          target: "row",
          member: "member",
          permission: "permission",
        },
        members: { table: "i_member", account: "account" },
      },
    },
    /**
     * **引き継ぎを辿るが、親の段で読む行が少ない表**((E-3) の台)。
     * **1,001 行あっても既存の 1,000 は1度も発火しない** —— **あの上限は
     * 「1回の判定で辿って読む行」を数えるのであって、表の行数を数えていない。**
     */
    {
      id: "j_child",
      name: "引き継ぎ先(付与が少ない)",
      fields: [
        { id: "title", name: "件名", type: "text", required: true },
        { id: "tag", name: "区分", type: "select", options: ["A", "B"] },
        { id: "parent", name: "親", type: "reference", reference_table: "i_flat" },
      ],
      access_control: {
        enabled: true,
        permissions: [{ id: "reader", name: "参照のみ", read: true, write: false, delete: false }],
        creator_permission: "reader",
        grant: {
          table: "j_child_grant",
          target: "row",
          member: "member",
          permission: "permission",
        },
        members: { table: "i_member", account: "account" },
        inherit_from: ["parent"],
      },
    },
    {
      id: "j_child_grant",
      name: "引き継ぎ先(付与が少ない)の付与",
      fields: [
        { id: "row", name: "行", type: "reference", reference_table: "j_child" },
        { id: "member", name: "相手", type: "reference", reference_table: "i_member" },
        { id: "permission", name: "権限", type: "select", options: ["reader"] },
      ],
    },
    {
      id: "i_flat_grant",
      name: "付与だけの表の付与",
      fields: [
        { id: "row", name: "行", type: "reference", reference_table: "i_flat" },
        { id: "member", name: "相手", type: "reference", reference_table: "i_member" },
        { id: "permission", name: "権限", type: "select", options: ["reader"] },
      ],
    },
    /**
     * **【2026-08-15。`V8-M11-T04`。台帳 `Q-G21b`(群のページ送り)。ユーザ決定 `D-V8-129`】**
     * **ページ送りの台。** **250 行あり、`bucket` が `"A"` の行が**ちょうど 101 行**である。**
     * **`_id` で束ねると、群が行数と同じ数だけできる**(`rep_groups_over` と同じ狙いだが、
     * **こちらは結合を使わず1表で足りる**)。
     * **上限には1度も当たらない**(250 行 / 250 群はどちらも 10,000 の内側)——
     * **ここで測るのは上限ではなく、既定の `limit`(100)と `total_groups` の関係である。**
     */
    {
      id: "p_page",
      name: "ページ送りの台",
      fields: [
        { id: "label", name: "見出し", type: "text", required: true },
        { id: "bucket", name: "束", type: "select", options: ["A", "B"] },
      ],
    },
  ];
}

function views(): Any[] {
  const sums = [{ type: "sum", field: "amount" }, { type: "count" }];
  return [
    // 10,001 行を全部読む(上限を超える)。
    {
      id: "rep_all",
      type: "report_view",
      table: "t_big",
      name: "全部",
      report: { group_by: [{ field: "tag" }], aggregates: sums },
    },
    // 絞り込みで 10,000 行ちょうどにする(上限ちょうど = 通る)。
    {
      id: "rep_exact",
      type: "report_view",
      table: "t_big",
      name: "ちょうど",
      report: {
        group_by: [{ field: "tag" }],
        aggregates: sums,
        filter: { field: "tag", equals: "A" },
      },
    },
    // **群 = 行数** の形(`D-V8-126`。`T07` が測る形)。**10,000 ちょうど。**
    {
      id: "rep_ids_exact",
      type: "report_view",
      table: "t_big",
      name: "行ごと(ちょうど)",
      report: {
        group_by: [{ field: "_id" }],
        aggregates: sums,
        filter: { field: "tag", equals: "A" },
      },
    },
    // **群 = 行数** の形で 10,001。**先に当たるのはどちらの上限か**を測る((A-5))。
    {
      id: "rep_ids_all",
      type: "report_view",
      table: "t_big",
      name: "行ごと(全部)",
      report: { group_by: [{ field: "_id" }], aggregates: sums },
    },
    // 逆方向の結合で群を 10,001 にする(読む行はどちらの表も 10,000 以下)。
    {
      id: "rep_groups_over",
      type: "report_view",
      table: "g_parent",
      name: "群が多すぎる",
      report: {
        join: [{ table: "g_child", via: "parent" }],
        group_by: [{ table: "g_child", field: "_id" }],
        aggregates: [{ type: "sum", table: "g_child", field: "amount" }, { type: "count" }],
      },
    },
    // 引き継ぎの台(行は 1,001 行。既存の 1,000 との関係を測る)。
    {
      id: "rep_inherit",
      type: "report_view",
      table: "i_child",
      name: "引き継ぎ先の集計",
      report: { group_by: [{ field: "tag" }], aggregates: [{ type: "count" }] },
    },
    // 引き継ぎの**段数**の台(6段目に進もうとする鎖)。
    {
      id: "rep_depth",
      type: "report_view",
      table: "d_chain",
      name: "段が深い",
      report: { group_by: [{ field: "tag" }], aggregates: [{ type: "count" }] },
    },
    // 引き継ぎを辿るが親の段で読む行が少ない表(1,001 行)。
    {
      id: "rep_j",
      type: "report_view",
      table: "j_child",
      name: "1,001 行あるだけの集計",
      report: { group_by: [{ field: "tag" }], aggregates: [{ type: "count" }] },
    },
    // 行アクセス権はあるが引き継ぎが無い表(10,001 行)。
    {
      id: "rep_flat",
      type: "report_view",
      table: "i_flat",
      name: "付与だけの表の集計",
      report: { group_by: [{ field: "tag" }], aggregates: [{ type: "count" }] },
    },
    // **【`V8-M11-T04`】ページ送りの台。** **250 群**(`_id` で束ねる = 群の数 = 行数)。
    {
      id: "rep_p250",
      type: "report_view",
      table: "p_page",
      name: "250 群",
      report: { group_by: [{ field: "_id" }], aggregates: [{ type: "count" }] },
    },
    // **既定の `limit`(100)の当たり先。** **101 群ちょうど**(`bucket = "A"` の行だけ)。
    {
      id: "rep_p101",
      type: "report_view",
      table: "p_page",
      name: "101 群",
      report: {
        group_by: [{ field: "_id" }],
        aggregates: [{ type: "count" }],
        filter: { field: "bucket", equals: "A" },
      },
    },
  ];
}

function roles(): Any[] {
  const viewRules = views().map((view) => ({ target: "view", view: view.id, can: ["read"] }));
  const allTables = tables().map((table) => ({
    target: "table",
    table: table.id,
    can: ["read", "write", "delete"],
  }));
  return [
    { id: "owner", name: "持ち主", rules: [...OWNER_BASE, ...allTables, ...viewRules] },
    {
      id: "editor",
      name: "係",
      rules: [
        // **条件つきの読取だけ** —— **`st_owner` が自分の行だけ = 0行になる。**
        {
          target: "table",
          table: "t_big",
          can: ["read"],
          when: { field: "st_owner", equals_current_user: true },
        },
        ...viewRules,
      ],
    },
    { id: "viewer", name: "閲覧", rules: viewRules },
  ];
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;
let u1: ReturnType<typeof seedSession>;
let u2: ReturnType<typeof seedSession>;

beforeAll(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-report-limit-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "集計表の上限", { app_id: APP_ID });
  } finally {
    store.close();
  }
  u1 = seedSession(dataRoot, APP_ID, { role: "owner", username: "u1-owner" });
  u2 = seedSession(dataRoot, APP_ID, { role: "editor", username: "u2-staff" });

  const applied = applyManifest(dataRoot, APP_ID, {
    app: { id: APP_ID, name: "集計表の上限", tables: tables(), views: views(), roles: roles() },
  } as unknown as Manifest);
  expect(
    applied.valid,
    applied.valid ? "" : JSON.stringify((applied as { errors: unknown }).errors),
  ).toBe(true);
  const manifest = (applied as { manifest: Manifest }).manifest;

  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  const add = (table: string, input: Any): string => {
    const result = createRecord(db, manifest, table, input);
    expect(result.ok, result.ok ? "" : JSON.stringify((result as { errors: unknown }).errors)).toBe(
      true,
    );
    return (result as { value: { _id: string } }).value._id;
  };
  try {
    // **1回のトランザクションで入れる**(2万行で 0.1 秒未満)。
    db.exec("BEGIN");
    // --- `t_big`: 10,001 行。**うち区分 A がちょうど 10,000 行。** ------------------
    for (let index = 0; index < MAX_REPORT_SCANNED_ROWS + 1; index += 1) {
      add("t_big", {
        title: `行${index}`,
        amount: 1,
        tag: index < MAX_REPORT_SCANNED_ROWS ? "A" : "B",
        // **誰のものでもない** —— **係(条件つき読取)からは1行も見えない。**
        st_owner: "someone-else",
      });
    }
    // --- 群の台: 親2行 + 子 10,000 行(全部 親#1) -------------------------------
    const parentA = add("g_parent", { label: "親A" });
    add("g_parent", { label: "親B(子が1件も無い)" });
    for (let index = 0; index < MAX_REPORT_GROUPS; index += 1) {
      add("g_child", { label: `子${index}`, amount: 1, parent: parentA });
    }
    // --- 引き継ぎの台 -------------------------------------------------------------
    const member = add("i_member", { account: u1.userId });
    const iParent = add("i_parent", { label: "親" });
    // **親の段で読む付与行を 1,001 件にする**(既存の 1,000 の数え方は
    // 「段0 の付与行を数えず、親の段の付与行を数える」)。
    for (let index = 0; index <= 1000; index += 1) {
      add("i_parent_grant", { row: iParent, member, permission: "reader" });
    }
    // 引き継ぎ先は 1,001 行(**行数だけでは既存の 1,000 は落とさない**ことの台)。
    for (let index = 0; index <= 1000; index += 1) {
      add("i_child", { title: `子${index}`, tag: "A", parent: iParent });
    }
    // --- 段の鎖: 7段(段0 から数えて段6 に進もうとするので、既存の5段に当たる)-----
    let parentOfChain: string | undefined;
    for (let level = 6; level >= 0; level -= 1) {
      const row: Any = { title: `段${level}`, tag: "A" };
      if (parentOfChain !== undefined) {
        row.parent = parentOfChain;
      }
      parentOfChain = add("d_chain", row);
    }
    // --- 行アクセス権はあるが引き継ぎが無い表: 10,001 行 -------------------------
    let flatFirst: string | undefined;
    for (let index = 0; index < MAX_REPORT_SCANNED_ROWS + 1; index += 1) {
      const id = add("i_flat", { title: `平${index}`, tag: "A" });
      flatFirst ??= id;
    }
    // --- 引き継ぎを辿るが親の段で読む行が少ない表: 1,001 行 ----------------------
    for (let index = 0; index <= 1000; index += 1) {
      add("j_child", { title: `少${index}`, tag: "A", parent: flatFirst });
    }
    // --- 【`V8-M11-T04`】ページ送りの台: 250 行(先頭 101 行だけ `bucket = "A"`)-----
    for (let index = 0; index < 250; index += 1) {
      add("p_page", { label: `頁${index}`, bucket: index < 101 ? "A" : "B" });
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }

  app = createServerApp({ dataRoot });
});

afterAll(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function req(cookie: string | undefined, path: string) {
  const headers: Record<string, string> = { origin: TEST_ORIGIN };
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  return Promise.resolve(
    app.request(new Request(`http://localhost${path}`, { method: "GET", headers })),
  );
}

type ReportBody = {
  groups?: { keys: { field: string; value: unknown }[]; aggregates: Any[] }[];
  total_groups?: number;
  totals?: { type: string; field?: string; value: number }[];
  errors?: { path: string; message: string; hint?: string }[];
};

/**
 * **集計表を1枚読む。**
 *
 * **【2026-08-15。`V8-M11-T04` の追記。既存の呼び出しを1件も書き換えていない】**
 * **`query` は省略できる** —— **省略したときの `URL` は着手前と1バイト同じである
 * (`?` を付けない)。** **ページ送りを打つ検査だけが渡す。**
 */
async function report(
  cookie: string,
  viewId: string,
  query?: string,
): Promise<{ status: number; body: ReportBody; text: string }> {
  const suffix = query === undefined ? "" : `?${query}`;
  const res = await req(cookie, `/api/apps/${APP_ID}/views/${viewId}/report${suffix}`);
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as ReportBody, text };
}

const SCANNED_ROWS_SENTENCE = "群にまとめる前に読む行の件数";
const GROUPS_SENTENCE = "まとめた群の数";
const INHERIT_SENTENCE = "引き継ぎの上限を超えているため判定できません";

function messageOf(body: ReportBody): string {
  return body.errors?.[0]?.message ?? "";
}

// =====================================================================================
// (A) inclusive —— **上限ちょうどは通り、超えたら 4xx**(§1-0c の決定3)
// =====================================================================================

test("(A-1) 読む行が上限ちょうど(10,000)なら 200 で通る", async () => {
  const out = await report(u1.cookie, "rep_exact");
  expect(out.status).toBe(200);
  expect(out.body.totals?.find((aggregate) => aggregate.type === "count")?.value).toBe(
    MAX_REPORT_SCANNED_ROWS,
  );
});

test("(A-2) 読む行が上限を1件超える(10,001)と要求全体が 400 になる", async () => {
  const out = await report(u1.cookie, "rep_all");
  expect(out.status).toBe(400);
  expect(messageOf(out.body)).toContain(SCANNED_ROWS_SENTENCE);
  // **部分的な結果を返さない**(`T05` 完了条件2)。
  expect(out.body.groups).toBeUndefined();
  expect(out.body.totals).toBeUndefined();
  // **どの表かを載せない**(§1-0c の決定2 の 1')。
  expect(out.text.includes("t_big")).toBe(false);
});

test("(A-3) 群が上限ちょうど(10,000)なら 200 で通る(`_id` で束ねる = 群の数 = 行数)", async () => {
  const out = await report(u1.cookie, "rep_ids_exact");
  expect(out.status).toBe(200);
  expect(out.body.total_groups).toBe(MAX_REPORT_GROUPS);
});

test("(A-4) 群が上限を1つ超える(10,001)と 400 になる(読む行はどちらの表も上限以下)", async () => {
  const out = await report(u1.cookie, "rep_groups_over");
  expect(out.status).toBe(400);
  expect(messageOf(out.body)).toContain(GROUPS_SENTENCE);
  expect(messageOf(out.body)).not.toContain(SCANNED_ROWS_SENTENCE);
  expect(out.body.total_groups).toBeUndefined();
});

test("(A-5) `_id` で束ねて 10,001 行にすると、先に当たるのは**行**の上限である", async () => {
  // **群の上限も同時に超えているが、行を読んだ時点で止まるので群は1つも作られない。**
  // **`T07` が「群が上限ちょうど」を測るときは (A-3) の形を使うこと。**
  const out = await report(u1.cookie, "rep_ids_all");
  expect(out.status).toBe(400);
  expect(messageOf(out.body)).toContain(SCANNED_ROWS_SENTENCE);
  expect(messageOf(out.body)).not.toContain(GROUPS_SENTENCE);
});

// =====================================================================================
// (B) **表ごとに2箇所で数える**(§1-0c の決定2)
// =====================================================================================

test("(B-1) 1行も見えない人にも (i) が当たる —— 数えているのは可視性の**前**の行数である", async () => {
  // **係は条件つきの読取しか持たず、`t_big` の 10,001 行が1行も見えない。**
  // **可視性の**後**だけで数えていたら 0 行なので 200 になるはずだが、400 である。**
  const out = await report(u2.cookie, "rep_all");
  expect(out.status).toBe(400);
  expect(messageOf(out.body)).toContain(SCANNED_ROWS_SENTENCE);
});

test("(B-2) 同じ人が、絞り込みで 10,000 行に収まる画面を開くと 200 で0件が返る", async () => {
  const out = await report(u2.cookie, "rep_exact");
  expect(out.status).toBe(200);
  expect(out.body.totals?.find((aggregate) => aggregate.type === "count")?.value).toBe(0);
});

test("(B-3) 白箱: 数える場所は集計表の口に2箇所ある。カーネルには1つも無い", async () => {
  const source = await Bun.file(join(PRODUCT_ROOT, "src", "server", "app.ts")).text();
  const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
  // **(i) 生の行数 と (ii) 可視性を通した後の行数** —— **2箇所ちょうど。**
  expect(code.filter((line) => line.includes("exceedsReportScannedRows("))).toHaveLength(2);
  // **群の数は1箇所(要求全体を返す直前)。**
  expect(code.filter((line) => line.includes("exceedsReportGroups("))).toHaveLength(1);
  // **カーネルは上限を1つも知らない**(`src/kernel/report.ts` を1バイトも触っていない)。
  const kernel = await Bun.file(join(PRODUCT_ROOT, "src", "kernel", "report.ts")).text();
  for (const needle of [
    "exceedsReportScannedRows",
    "exceedsReportGroups",
    "MAX_REPORT_SCANNED_ROWS",
    "MAX_REPORT_GROUPS",
    "report-limits",
  ]) {
    expect([needle, kernel.includes(needle)]).toEqual([needle, false]);
  }
});

test("(B-4) 【正直に書く】(ii) は今日1度も発火しない —— 可視性は行を増やさないからである", () => {
  // **(i) と (ii) は同じ上限(10,000)を同じ述語で見ている。**
  // **可視性の post-filter は部分集合しか返さないので `(ii) ≤ (i)` が常に成り立つ。**
  // **したがって (i) が先に返す限り、(ii) だけが当たる入力は存在しない。**
  // **それでも2箇所書いてあるのは、(i) の側を緩めた日に (ii) が最後の歯止めになるためである**
  // (§1-0c の決定2 は「表ごとに2箇所で数える」と定めている)。
  expect(MAX_REPORT_SCANNED_ROWS).toBe(10000);
  expect(MAX_REPORT_GROUPS).toBe(10000);
});

// =====================================================================================
// (C) 上限に当たった応答 vs 本当に0件の応答(`D-V8-128`)
// =====================================================================================

test("(C-1) 本当に0件は 200・合計0・件数0・群0。上限は 400 で `errors` を持つ", async () => {
  const zero = await report(u2.cookie, "rep_exact");
  const limited = await report(u2.cookie, "rep_all");
  expect([zero.status, limited.status]).toEqual([200, 400]);
  // **0件の応答は `errors` を1つも持たない。**
  expect(zero.body.errors).toBeUndefined();
  expect(zero.body.total_groups).toBe(0);
  expect(zero.body.groups).toEqual([]);
  // **上限の応答は `groups` / `totals` / `total_groups` を1つも持たない。**
  expect(limited.body.errors).toHaveLength(1);
  expect(limited.body.total_groups).toBeUndefined();
  // **本文そのものが1バイトも似ていない。**
  expect(limited.text).not.toBe(zero.text);
});

// =====================================================================================
// (D) 上限の種別6つが互いに区別できる(`T05` 完了条件 3')
// =====================================================================================

test("(D-1) 読取時の上限4種は、集計表の同じ口から、応答本文の文面で互いに区別できる", async () => {
  // **集計表の2種**(本タスクが作った)。
  const rows = messageOf((await report(u1.cookie, "rep_all")).body);
  const groups = messageOf((await report(u1.cookie, "rep_groups_over")).body);
  // **引き継ぎの2種**(既存。`Z-G17` / `V7-M4-T04`。**本マイルストーンが作ったものではない**)。
  const inheritRows = messageOf((await report(u1.cookie, "rep_inherit")).body);
  const inheritDepth = messageOf((await report(u1.cookie, "rep_depth")).body);
  const four = [rows, groups, inheritRows, inheritDepth];
  // **4種とも互いに1バイトも同じでない。**
  expect(new Set(four).size).toBe(four.length);
  expect(rows).toContain(SCANNED_ROWS_SENTENCE);
  expect(groups).toContain(GROUPS_SENTENCE);
  expect(inheritRows).toContain("たどって読む行の件数");
  expect(inheritDepth).toContain("たどる段数");
  // **集計表の上限は、引き継ぎの上限の文面と混ざらない。**
  expect(rows).not.toContain(INHERIT_SENTENCE);
  expect(groups).not.toContain(INHERIT_SENTENCE);
  expect([inheritRows, inheritDepth].every((message) => message.includes(INHERIT_SENTENCE))).toBe(
    true,
  );
});

test("(D-2) apply 時の上限(段3)は、読取時の4種と1バイトも混ざらない", () => {
  // **`d_chain` を4段辿ろうとする**(順方向。**起点 → 親 → 親 → 親 → 親**)。
  const applied = applyManifest(dataRoot, `${APP_ID}-deep`, {
    app: {
      id: `${APP_ID}-deep`,
      name: "x",
      tables: tables(),
      views: [
        {
          id: "deep",
          type: "report_view",
          table: "d_chain",
          name: "深すぎる",
          report: {
            join: [
              { table: "d_chain", via: "parent" },
              { table: "d_chain", via: "parent" },
            ],
            group_by: [{ field: "tag" }],
            aggregates: [{ type: "count" }],
          },
        },
      ],
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [...OWNER_BASE, { target: "view", view: "deep", can: ["read"] }],
        },
        { id: "editor", name: "係", rules: [{ target: "view", view: "deep", can: ["read"] }] },
        { id: "viewer", name: "閲覧", rules: [{ target: "view", view: "deep", can: ["read"] }] },
      ],
    },
  } as unknown as Manifest);
  expect(applied.valid).toBe(false);
  const messages = ((applied as { errors: { message: string }[] }).errors ?? [])
    .map((error) => error.message)
    .join("\n");
  // **読取時の4種のどれとも重ならない。**
  expect(messages).not.toContain(SCANNED_ROWS_SENTENCE);
  expect(messages).not.toContain(GROUPS_SENTENCE);
  expect(messages).not.toContain(INHERIT_SENTENCE);
});

test("(D-3) 【正直に書く】表の本数(5)の文面は今日1度も出ない —— スキーマが先に止める", () => {
  // **`report.join` の `maxItems` は 4 である** —— **起点を含めて5表までは書けるが、
  // 6表目を書こうとするとスキーマが先に落とす。**
  // **`referential-integrity.ts` の本数の検査(「起点を含めて 5 本まで」)は、
  // そのため1度も発火しない**(同ファイルの doc が着手前からそう書いている)。
  // **したがって「6種類の上限」のうち1つは、実物では**スキーマのエラー文**として現れる。**
  const applied = applyManifest(dataRoot, `${APP_ID}-wide`, {
    app: {
      id: `${APP_ID}-wide`,
      name: "x",
      tables: tables(),
      views: [
        {
          id: "wide",
          type: "report_view",
          table: "d_chain",
          name: "広すぎる",
          report: {
            join: [
              { table: "d_chain", via: "parent" },
              { table: "d_chain", via: "parent" },
              { table: "d_chain", via: "parent" },
              { table: "d_chain", via: "parent" },
              { table: "d_chain", via: "parent" },
            ],
            group_by: [{ field: "tag" }],
            aggregates: [{ type: "count" }],
          },
        },
      ],
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [...OWNER_BASE, { target: "view", view: "wide", can: ["read"] }],
        },
        { id: "editor", name: "係", rules: [{ target: "view", view: "wide", can: ["read"] }] },
        { id: "viewer", name: "閲覧", rules: [{ target: "view", view: "wide", can: ["read"] }] },
      ],
    },
  } as unknown as Manifest);
  expect(applied.valid).toBe(false);
  const messages = ((applied as { errors: { message: string }[] }).errors ?? [])
    .map((error) => error.message)
    .join("\n");
  expect(messages).toContain("maxItems");
  // **本数の検査そのものの文面は出ていない**(発火していないことの実測)。
  expect(messages).not.toContain("起点を含めて");
  expect(messages).not.toContain(SCANNED_ROWS_SENTENCE);
  expect(messages).not.toContain(GROUPS_SENTENCE);
});

// =====================================================================================
// (E) 既存の 1,000(引き継ぎ)と集計表の 10,000 の関係(`T05` 完了条件 3'')
// =====================================================================================

test("(E-1) 引き継ぎを辿る表では、既存の 1,000 が集計表の 10,000 より先に落とす", async () => {
  // **`i_child` は 1,001 行しかないので集計表の 10,000 には届かない。**
  // **落としているのは親の段で読む付与行 1,001 件のほうである。**
  const out = await report(u1.cookie, "rep_inherit");
  expect(out.status).toBe(400);
  expect(messageOf(out.body)).toContain(INHERIT_SENTENCE);
  expect(messageOf(out.body)).toContain("たどって読む行の件数");
});

test("(E-2) 行が 1,001 行あるだけでは、既存の 1,000 は1度も発火しない", async () => {
  // **既存の 1,000 が数えるのは「1回の判定で辿って読む行」であって、表の行数ではない。**
  // **`j_child` は 1,001 行あり、引き継ぎも辿るが、親の段で読む行が数件しかないので通る。**
  // **したがって「行を 1,001 行にすれば既存の 1,000 が先に落とす」とは書けない** ——
  // **落とすのは、親の段で読む付与行が 1,001 件あるとき((E-1))だけである。**
  const out = await report(u1.cookie, "rep_j");
  expect(out.status).toBe(200);
  expect(out.body.totals?.find((aggregate) => aggregate.type === "count")?.value).toBe(1001);
});

test("(E-3) 行アクセス権を宣言していても、引き継ぎが無ければ集計表の 10,000 に到達する", async () => {
  // **既存の 1,000 は「親の段で読む行」しか数えない**(`owner-scope.ts` の数え方の逐語)。
  // **`inherit_from` を持たない表では、その1,000 は1度も発火しない。**
  // **したがって「集計表の上限4値は、行アクセス権を宣言した表では到達しない」とは書けない。**
  const out = await report(u1.cookie, "rep_flat");
  expect(out.status).toBe(400);
  expect(messageOf(out.body)).toContain(SCANNED_ROWS_SENTENCE);
  expect(messageOf(out.body)).not.toContain(INHERIT_SENTENCE);
});

// =====================================================================================
// (F) ページ送り(`?limit=` / `?offset=`)—— `V8-M11-T04`。台帳 `Q-G21b`。
//     ユーザ決定 `D-V8-129`(**既定は 100 群。画面の上に出る全体の合計は全部を数えた値**)。
//     実施記録 `docs/plan/v8/records/v8-m11.md` §1 の `T04` / §1-0c の決定5 / 決定6。
//
//     **ここは `API` の応答だけで判定する**(§1-0d の (丁)(iv))——
//     **画面(`web/`)の DOM 検査で代用していない。画面を1枚も開いていない。**
// =====================================================================================

test("(F-1) 既定の limit は 100 である —— limit を書かなければ 101 件目の群は返らない", async () => {
  // **`rep_p101` は群が 101 個ちょうどできる台である**(`bucket = "A"` の 101 行)。
  const out = await report(u1.cookie, "rep_p101");
  expect(out.status).toBe(200);
  expect(out.body.groups).toHaveLength(100);
  // **切ったのは `groups` だけである** —— **群の総数は 101 のままである(決定6)。**
  expect(out.body.total_groups).toBe(101);
  expect(out.body.totals?.find((aggregate) => aggregate.type === "count")?.value).toBe(101);
});

test("(F-2) total_groups と totals はページを切る前の全体である(群 250・?limit=100)", async () => {
  const out = await report(u1.cookie, "rep_p250", "limit=100");
  expect(out.status).toBe(200);
  expect(out.body.groups).toHaveLength(100);
  expect(out.body.total_groups).toBe(250);
  // **全体の合計も 250 行を数えた値である**(`D-V8-129` の説明文の逐語)。
  expect(out.body.totals?.find((aggregate) => aggregate.type === "count")?.value).toBe(250);
});

test("(F-3) offset は先頭からスキップする(最後のページは端数になる。全体の値は動かない)", async () => {
  const first = await report(u1.cookie, "rep_p250", "limit=100&offset=0");
  const last = await report(u1.cookie, "rep_p250", "limit=100&offset=200");
  expect(last.status).toBe(200);
  expect(last.body.groups).toHaveLength(50);
  expect(last.body.total_groups).toBe(250);
  // **同じ群を2度返していない**(先頭ページと最終ページの群が1つも重ならない)。
  const idOf = (body: ReportBody) => (body.groups ?? []).map((group) => group.keys[0]?.value);
  expect(idOf(first.body).some((id) => idOf(last.body).includes(id))).toBe(false);
  // **群の総数を超える `offset` は 200 で0件である**(400 にしない。既存のレコード経路と同じ)。
  const beyond = await report(u1.cookie, "rep_p250", "limit=100&offset=1000");
  expect([beyond.status, beyond.body.groups?.length, beyond.body.total_groups]).toEqual([
    200, 0, 250,
  ]);
});

test("(F-4) 上限はページ送りでは回避できない —— ?limit=10 を付けても群が 10,001 個できれば 400 のまま", async () => {
  /*
   * **`v8-m11.md` §1-0c の決定5。**
   * **上限は「作った群の数」の上限であって「返す群の数」の上限ではない** ——
   * **`D-V8-122`(ページ送りしても出すのは全体の合計)により、全群を数え直す必要がある。**
   * **【禁止】「ページ送りを付ければ重い集計表も開ける」と書かない。**
   *
   * **台は (A-4) と同じ `rep_groups_over`(結合のファンアウトで群だけを増やす形)である** ——
   * **1表 10,001 行で作ると、先に当たるのは群ではなく**行**の上限である**((A-5) の実測。乙3)。
   */
  const out = await report(u1.cookie, "rep_groups_over", "limit=10");
  expect(out.status).toBe(400);
  expect(messageOf(out.body)).toContain(GROUPS_SENTENCE);
  expect(messageOf(out.body)).not.toContain(SCANNED_ROWS_SENTENCE);
  // **部分的な結果を1バイトも返さない**(ページの1枚目すら返さない)。
  expect(out.body.groups).toBeUndefined();
  expect(out.body.total_groups).toBeUndefined();
  // **`offset` を付けても同じである。**
  const skipped = await report(u1.cookie, "rep_groups_over", "limit=10&offset=10000");
  expect(skipped.status).toBe(400);
});

test("(F-5) ?limit= にクランプを置いていない(既定より大きい値も、0 も、そのまま効く)", async () => {
  // **既存のレコード経路と揃える**(`T04` 完了条件 (vi))—— **上限に丸めない。**
  const big = await report(u1.cookie, "rep_p250", "limit=1000");
  expect(big.body.groups).toHaveLength(250);
  expect(big.body.total_groups).toBe(250);
  // **0 は「0件返す」であって「全件返す」ではない**(黙って化けさせない)。
  const zero = await report(u1.cookie, "rep_p250", "limit=0");
  expect([zero.status, zero.body.groups?.length, zero.body.total_groups]).toEqual([200, 0, 250]);
});

test("(F-6) 応答に limit / offset を1バイトもエコーしていない(応答のキーは着手前と同じ3つ)", async () => {
  const out = await report(u1.cookie, "rep_p250", "limit=5&offset=5");
  expect(Object.keys(out.body).sort()).toEqual(["groups", "total_groups", "totals"]);
  // **本文のどこにも `limit` / `offset` という綴りが出ない。**
  expect(out.text.includes("limit")).toBe(false);
  expect(out.text.includes("offset")).toBe(false);
});

test("(F-7) 壊れた limit / offset は 400 で、hint は集計表の既定(100 群)を説明する", async () => {
  /*
   * **`v8-m11.md` §1-0d の乙2 の宿題。**
   * **`decodePageParam` の hint の逐語「省略すると全件返します」は、集計表では嘘になる** ——
   * **集計表は省略すると先頭 100 群しか返さないからである。**
   * **`decodePageParam` の実装は1バイトも変えていない**(完了条件 (i'))——
   * **差し替えは呼び出し側(集計表ルート)で行っている。**
   * **一覧の読取ルートの hint は今日も1バイトも変わっていない**(下で対照している)。
   */
  for (const query of ["limit=abc", "limit=-1", "offset=1.5", "limit=1e2"]) {
    const out = await report(u1.cookie, "rep_p250", query);
    expect(out.status, query).toBe(400);
    expect(out.body.errors?.length, query).toBeGreaterThan(0);
  }
  const limitError = (await report(u1.cookie, "rep_p250", "limit=abc")).body.errors?.[0];
  expect(limitError?.path).toBe("/limit");
  expect(limitError?.hint).toContain("100");
  expect(limitError?.hint).not.toContain("省略すると全件返します");
  // **`offset` の hint は一覧と同じままである**(集計表でも意味が変わらないため)。
  const offsetError = (await report(u1.cookie, "rep_p250", "offset=1.5")).body.errors?.[0];
  expect(offsetError?.path).toBe("/offset");
  expect(offsetError?.hint).toContain("先頭からスキップする件数");
  // **一覧の読取ルートの hint は着手前の逐語のままである**(集計表の都合を持ち込んでいない)。
  const listRes = await req(u1.cookie, `/api/apps/${APP_ID}/tables/p_page/records?limit=abc`);
  expect(listRes.status).toBe(400);
  const listBody = (await listRes.json()) as ReportBody;
  expect(listBody.errors?.[0]?.hint).toContain("省略すると全件返します");
});

test("(F-8) 白箱: ページを切るのは既存の slicePage 1本で、2本目のページパーサを作っていない", async () => {
  const source = await Bun.file(join(PRODUCT_ROOT, "src", "server", "app.ts")).text();
  const start = source.indexOf('app.get("/api/apps/:app_id/views/:view_id/report"');
  const end = source.indexOf('app.get("/api/apps/:app_id/views/:view_id/custom.css"', start);
  const code = source
    .slice(start, end)
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
  // **切るのは1箇所ちょうど。**
  expect(code.filter((line) => line.includes("slicePage("))).toHaveLength(1);
  // **数の復元は既存の `decodePageParam` 2回で、正規表現も `Number(` も書いていない。**
  expect(code.filter((line) => line.includes("decodePageParam("))).toHaveLength(2);
  expect(code.filter((line) => /Number\(|parseInt\(|\/\^\\d/.test(line))).toEqual([]);
  /*
   * **カーネルはページ送りを1文字も知らない**(`src/kernel/report.ts` を1バイトも触っていない)。
   *
   * **【`offset` をこの一覧に入れていない理由。書いたその場で打って気づいた】** ——
   * **`src/kernel/report.ts` には `offset` という綴りが2行ある**(`:174`-`:175`)が、
   * **それは週の始まりを月曜へ戻すときの「曜日のずれ」であって、ページ送りとは無関係である。**
   * **一覧に入れると、この検査は生まれた時点で赤くなる** ——
   * **「限定表の検査は生まれた時点で偽なことがある」の型を、ここで1件踏んだ。**
   */
  const kernel = await Bun.file(join(PRODUCT_ROOT, "src", "kernel", "report.ts")).text();
  for (const needle of ["limit", "slicePage", "decodePageParam"]) {
    expect([needle, kernel.includes(needle)]).toEqual([needle, false]);
  }
});
