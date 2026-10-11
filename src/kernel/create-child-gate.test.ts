/**
 * **子の表に行を作れる権限 —— 親の関門を広げる(作成だけ)**
 * (`V23-M7-T03`。門A = `ADR-0503`(`SC-G22`)を補う `ADR-0542` §Decision 1-2・1-3。
 * 決定 `D-V23-181`・`D-V23-183`・`D-V23-187`・`D-V23-188`・`D-V23-190`・`D-V23-191`。授権 `ADR-0543`)。
 *
 * ## この検査が測るもの / 測らないもの(**先に書く**)
 *
 * **題材**: 地域 → 組織 → 告知(評価の受け手の組織に、評価者が告知を出す形)。 組織の権限 `assessor`(読むだけ)に
 * `create_child: ["org_notices", "joint_notices"]`、`helper`(読むだけ)に `create_child: ["org_memos"]`。
 * 告知の兄弟の子(報告)・孫(告知へのコメント)・2つの親を持つ子(共同の告知)・`creatable_by` を持つ子(覚え書き)・
 * 評価(作れない子)を並べる。 評価機関の行を相手にした付与(`principal_row`)も1本置く。
 *
 * **測るもの**:
 * 1. **(U) 関門の条件**(`judgeCreateParentAccess` を直接呼ぶ) —— 作成で親に書けないときだけ、(1) 上限を当てた後に
 *    読め、上限が書込を止めていない (2) 親の行そのもの(段0)で `create_child` にこの子の表を含む名前を持つ (3) 子の
 *    `creatable_by` を今日の照合のまま満たす、の3つが真なら通す。 偽なら今日どおり `denied`(答えの種類を増やさない)。
 *    兄弟の子・孫・2つ目の親・付与表には効かない。 宣言の無い定義では読みの本数も答えも変わらない。
 * 2. **(E) 入口ごとに1本** —— HTTP の単件・一括、MCP の `insert_sample_data`・`write_records`、自動処理の
 *    `create_record`、島の `write_ops`・`output_table` で作れる。 受信口は通らない。 時刻起動は今日どおり素通し。
 *
 * **測らないもの(誇張しない)**: 作った人への付与(`T04`)。 付け替え(`T05`)。 行ごとの判定の5つ目のキーと画面(`T05b`)。
 * 生成器(`T06`)。 説明書・要件書の文(`T07`)。
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "../mcp/server.ts";
import { createServerApp } from "../server/app.ts";
import { judgeCreateParentAccess, rowGrantWriteJudge } from "../server/owner-scope.ts";
import { seedSession, TEST_ORIGIN } from "../server/test-helpers.ts";
import { InboundStore } from "./inbound-store.ts";
import {
  appDbPath,
  applyManifest,
  createApp,
  createRecord,
  KernelMetaStore,
  type Manifest,
} from "./index.ts";
import { ensureIslandRuntimeReady } from "./island-runner.ts";
import { runScheduledWorkflow } from "./workflow-runner.ts";

type Any = Record<string, unknown>;

const APP_ID = "cc-gate";
const ALL = ["read", "write", "delete"];
const SIGNING_KEY = "test-create-child-gate-key";
const KEY_ENV_VAR = "ST_TEST_CREATE_CHILD_GATE_KEY";

const ref = (id: string, table: string) => ({
  id,
  name: id,
  type: "reference",
  reference_table: table,
});

const perm = (id: string, read: boolean, write: boolean, del: boolean, extra: Any = {}) => ({
  id,
  name: id,
  read,
  write,
  delete: del,
  ...extra,
});

/** 付与表(対象の項目・利用者・権限の3列。`extra` で列を足す)。 */
function grantTable(
  id: string,
  target: string,
  targetTable: string,
  names: string[],
  extra: Any[] = [],
) {
  return {
    id,
    name: id,
    fields: [
      ref(target, targetTable),
      ref("member", "members"),
      ...extra,
      { id: "permission", name: "権限", type: "select", options: names },
    ],
  };
}

function governed(
  grantTableId: string,
  target: string,
  permissions: Any[],
  creator: string,
  extra: Any = {},
): Any {
  return {
    enabled: true,
    permissions,
    creator_permission: creator,
    grant: { table: grantTableId, target, member: "member", permission: "permission" },
    members: { table: "members", account: "account" },
    ...extra,
  };
}

const ORG_NAMES = ["org_admin", "assessor", "helper", "org_viewer", "org_block", "org_readonly"];

type GateWf = "act" | "isl" | "replace" | "sched" | "manual";

/**
 * 題材の定義。 `createChild: false` で `create_child` を1つも書かない(陰性対照)。
 * `wfs` で自動処理を選ぶ(きっかけはどれも指示の表 `cmds` の作成)。
 */
function gateManifest(options: { createChild?: boolean; wfs?: readonly GateWf[] } = {}): Manifest {
  const cc = options.createChild !== false;
  const wfs = options.wfs ?? [];
  const tablesForRules = [
    "members",
    "regions",
    "region_grants",
    "evaluators",
    "ev_grants",
    "orgs",
    "org_grants",
    "org_notices",
    "notice_grants",
    "notice_comments",
    "comment_grants",
    "org_reports",
    "report_grants",
    "joint_notices",
    "joint_grants",
    "org_memos",
    "memo_grants",
    "assessments",
    "assessment_grants",
    "cmds",
    "wf_log",
  ];
  const rules = tablesForRules.map((table) => ({ target: "table", table, can: ALL }));
  const onCmd = (id: string, actions: unknown[]) => ({
    id,
    name: id,
    trigger: { type: "on_create", table: "cmds" },
    history_table: "wf_log",
    actions,
  });
  const allWfs: Record<GateWf, unknown> = {
    act: onCmd("wf_act", [
      {
        action: "create_record",
        table: "org_notices",
        values: { title: "自動処理から", org: "$record.gorg" },
      },
    ]),
    isl: onCmd("wf_isl", [{ action: "run_function", function: "isl_notice", write_ops: true }]),
    replace: onCmd("wf_replace", [
      { action: "run_function", function: "out_notice", output_table: "org_notices" },
    ]),
    sched: {
      id: "wf_sched",
      name: "夜間に告知を作る",
      trigger: { type: "schedule", at: { hour: 3, minute: 0 }, table: "cmds" },
      history_table: "wf_log",
      actions: [
        {
          action: "create_record",
          table: "org_notices",
          values: { title: "時刻起動から", org: "$record.gorg" },
        },
      ],
    },
    // D-V23-259: 画面のボタン(手動起動)。 書き手は押した人。
    manual: {
      id: "wf_manual",
      name: "ボタンで告知を作る",
      trigger: { type: "manual", table: "cmds" },
      history_table: "wf_log",
      actions: [
        {
          action: "create_record",
          table: "org_notices",
          values: { title: "ボタンから", org: "$record.gorg" },
        },
      ],
    },
  };
  const viewRules = wfs.includes("manual")
    ? [
        { target: "view", view: "cmd_list", can: ["read"] },
        { target: "action", view: "cmd_list", action: "go", can: ["read"] },
      ]
    : [];
  return {
    app: {
      id: APP_ID,
      name: "子の表に行を作れる権限の関門",
      tables: [
        {
          id: "members",
          name: "名簿",
          representative_field: "name",
          fields: [
            { id: "name", name: "名前", type: "text", required: true },
            { id: "account", name: "利用者ID", type: "text", required: true },
          ],
        },
        {
          id: "regions",
          name: "地域",
          fields: [{ id: "title", name: "名前", type: "text" }],
          access_control: governed(
            "region_grants",
            "region",
            [
              perm("region_admin", true, true, true),
              perm("assessor", true, false, false),
              perm("org_viewer", true, false, false),
            ],
            "region_admin",
          ),
        },
        grantTable("region_grants", "region", "regions", [
          "region_admin",
          "assessor",
          "org_viewer",
        ]),
        {
          id: "evaluators",
          name: "評価機関",
          representative_field: "title",
          fields: [{ id: "title", name: "名前", type: "text" }],
          access_control: governed(
            "ev_grants",
            "ev",
            [perm("ev_manager", true, true, true), perm("ev_staff", true, false, false)],
            "ev_manager",
          ),
        },
        grantTable("ev_grants", "ev", "evaluators", ["ev_manager", "ev_staff"]),
        {
          id: "orgs",
          name: "組織",
          representative_field: "title",
          fields: [{ id: "title", name: "名前", type: "text" }, ref("region", "regions")],
          access_control: {
            ...governed(
              "org_grants",
              "org",
              [
                perm("org_admin", true, true, true),
                perm(
                  "assessor",
                  true,
                  false,
                  false,
                  cc ? { create_child: ["org_notices", "joint_notices"] } : {},
                ),
                perm("helper", true, false, false, cc ? { create_child: ["org_memos"] } : {}),
                perm("org_viewer", true, false, false),
                perm("org_block", false, false, false, { restrictive: true }),
                perm("org_readonly", true, false, false, { restrictive: true }),
              ],
              "org_admin",
              { inherit_from: ["region"] },
            ),
            grant: {
              table: "org_grants",
              target: "org",
              member: "member",
              permission: "permission",
              principal_row: { column: "evaluator", table: "evaluators", via: ["ev_staff"] },
            },
          },
        },
        grantTable("org_grants", "org", "orgs", ORG_NAMES, [ref("evaluator", "evaluators")]),
        {
          id: "org_notices",
          name: "告知",
          representative_field: "title",
          fields: [{ id: "title", name: "件名", type: "text" }, ref("org", "orgs")],
          access_control: governed(
            "notice_grants",
            "notice",
            [perm("author", true, true, true), perm("notice_reader", true, false, false)],
            "author",
            { inherit_from: ["org"] },
          ),
        },
        grantTable("notice_grants", "notice", "org_notices", ["author", "notice_reader"]),
        {
          id: "notice_comments",
          name: "告知へのコメント",
          fields: [{ id: "body", name: "本文", type: "text" }, ref("notice", "org_notices")],
          access_control: governed(
            "comment_grants",
            "comment",
            [perm("c_author", true, true, true)],
            "c_author",
            { inherit_from: ["notice"] },
          ),
        },
        grantTable("comment_grants", "comment", "notice_comments", ["c_author"]),
        {
          id: "org_reports",
          name: "報告",
          fields: [{ id: "title", name: "件名", type: "text" }, ref("org", "orgs")],
          access_control: governed(
            "report_grants",
            "report",
            [perm("r_author", true, true, true)],
            "r_author",
            { inherit_from: ["org"] },
          ),
        },
        grantTable("report_grants", "report", "org_reports", ["r_author"]),
        {
          id: "joint_notices",
          name: "共同の告知",
          fields: [
            { id: "title", name: "件名", type: "text" },
            ref("org", "orgs"),
            ref("ev", "evaluators"),
          ],
          access_control: governed(
            "joint_grants",
            "joint",
            [perm("j_author", true, true, true)],
            "j_author",
            { inherit_from: ["org", "ev"] },
          ),
        },
        grantTable("joint_grants", "joint", "joint_notices", ["j_author"]),
        {
          id: "org_memos",
          name: "覚え書き",
          fields: [{ id: "title", name: "件名", type: "text" }, ref("org", "orgs")],
          access_control: governed(
            "memo_grants",
            "memo",
            [
              perm("memo_author", true, true, true),
              perm("org_viewer", true, false, false),
              perm("assessor", true, false, false),
            ],
            "memo_author",
            { inherit_from: ["org"], creatable_by: ["org_viewer"] },
          ),
        },
        grantTable("memo_grants", "memo", "org_memos", ["memo_author", "org_viewer", "assessor"]),
        {
          id: "assessments",
          name: "評価",
          fields: [{ id: "title", name: "件名", type: "text" }, ref("org", "orgs")],
          access_control: governed(
            "assessment_grants",
            "assessment",
            [perm("as_author", true, true, true)],
            "as_author",
            { inherit_from: ["org"] },
          ),
        },
        grantTable("assessment_grants", "assessment", "assessments", ["as_author"]),
        {
          id: "cmds",
          name: "指示",
          fields: [
            { id: "title", name: "件名", type: "text" },
            { id: "gorg", name: "組織", type: "text" },
            // 自動処理の書き手はきっかけの行の所有者(個人所有の列)。 画面の口で作ると作った人が入る。
            { id: "st_owner", name: "所有者", type: "text" },
          ],
        },
        {
          id: "wf_log",
          name: "実行履歴",
          fields: [
            { id: "ran_at", name: "実行時刻", type: "date" },
            { id: "workflow", name: "ワークフロー", type: "text" },
            { id: "trigger_type", name: "起点", type: "text" },
            { id: "status", name: "結果", type: "text" },
            { id: "error", name: "詳細", type: "long_text" },
          ],
        },
      ],
      views: wfs.includes("manual")
        ? [
            {
              id: "cmd_list",
              type: "list_view",
              table: "cmds",
              columns: ["title"],
              actions: [{ id: "go", run: "wf_manual", name: "作る" }],
            },
          ]
        : [],
      functions: [
        {
          id: "isl_notice",
          name: "島が告知を作る",
          code: 'export default function (record) { return [{ op: "create", table: "org_notices", values: { title: "島から", org: record.gorg } }]; }',
          input: { source: "record" },
          output: { ops: true },
        },
        {
          id: "out_notice",
          name: "告知を作り直す",
          code: 'export default function (record) { return [{ title: "置き換え", org: record.gorg }]; }',
          input: { source: "record" },
          output: {
            fields: [
              { id: "title", type: "text" },
              { id: "org", type: "reference" },
            ],
          },
        },
      ],
      workflows: wfs.map((wf) => allWfs[wf]),
      roles: [
        {
          id: "owner",
          name: "運営",
          rules: [
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
            ...rules,
            ...viewRules,
          ],
        },
        // 担当は、行ごとのアクセス権を宣言した表に役割の規則を1本も持たない(面と点は OR なので、面で書込を
        // 許すと点の判定が見えなくなる)。 きっかけの表と履歴の表にだけ書ける。
        {
          id: "staff",
          name: "担当",
          rules: [
            ...rules.filter((rule) => rule.table === "cmds" || rule.table === "wf_log"),
            ...viewRules,
          ],
        },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
      ],
    },
  } as unknown as Manifest;
}

// =====================================================================================
// (U) 関門の条件(`judgeCreateParentAccess` を直接呼ぶ。行は手で並べる)
// =====================================================================================

type Rows = Record<string, Record<string, unknown>[]>;

/** 利用者 → 名簿の行。 名前は `u_<x>`、名簿の行は `m_<x>`。 */
const PEOPLE = [
  "admin",
  "assessor",
  "helper",
  "both",
  "anc",
  "region_assessor",
  "blocked",
  "readonly",
  "expert",
  "viewer",
  "none",
];

function memoryRows(): Rows {
  const g = (target: string, id: string, who: string, permission: string, extra: Any = {}) => ({
    _id: `${target}-${who}-${permission}`,
    [target]: id,
    member: `m_${who}`,
    permission,
    ...extra,
  });
  return {
    members: PEOPLE.map((who) => ({ _id: `m_${who}`, name: who, account: `u_${who}` })),
    regions: [{ _id: "R1", title: "地域1" }],
    region_grants: [
      g("region", "R1", "admin", "region_admin"),
      g("region", "R1", "region_assessor", "assessor"),
      g("region", "R1", "anc", "org_viewer"),
    ],
    evaluators: [{ _id: "E1", title: "評価機関1" }],
    ev_grants: [g("ev", "E1", "expert", "ev_staff")],
    orgs: [
      { _id: "O1", title: "組織1", region: "R1" },
      { _id: "O2", title: "組織2", region: "R1" },
    ],
    org_grants: [
      g("org", "O1", "admin", "org_admin"),
      g("org", "O2", "admin", "org_admin"),
      g("org", "O1", "assessor", "assessor"),
      g("org", "O1", "helper", "helper"),
      g("org", "O1", "both", "helper"),
      g("org", "O1", "both", "org_viewer"),
      g("org", "O1", "anc", "helper"),
      g("org", "O1", "blocked", "assessor"),
      g("org", "O1", "blocked", "org_block"),
      g("org", "O1", "readonly", "assessor"),
      g("org", "O1", "readonly", "org_readonly"),
      g("org", "O1", "viewer", "org_viewer"),
      { _id: "org-E1-assessor", org: "O1", evaluator: "E1", permission: "assessor" },
    ],
    org_notices: [{ _id: "N0", title: "管理者の告知", org: "O1" }],
    notice_grants: [g("notice", "N0", "admin", "author")],
  };
}

type Judged = { kind: string; reads: { row: string[]; rows: string[] } };

function judge(
  manifest: Manifest,
  tableId: string,
  values: Record<string, unknown>,
  who: string,
  rows: Rows = memoryRows(),
  previous?: Record<string, unknown>,
): Judged {
  const reads = { row: [] as string[], rows: [] as string[] };
  const verdict = judgeCreateParentAccess({
    manifest,
    tableId,
    values,
    actorId: `u_${who}`,
    readRows: (id) => {
      reads.rows.push(id);
      return rows[id] ?? [];
    },
    readRow: (id, recordId) => {
      reads.row.push(`${id}/${recordId}`);
      return (rows[id] ?? []).find((row) => row._id === recordId);
    },
    ...(previous === undefined ? {} : { previous }),
  });
  return { kind: verdict.kind, reads };
}

const M = gateManifest();
const NO_CC = gateManifest({ createChild: false });

describe("V23-M7-T03 (U) 関門の条件", () => {
  test("(U-1) 組織に書けない評価者が、create_child に名の出る告知を作れる", () => {
    expect(judge(M, "org_notices", { title: "告知", org: "O1" }, "assessor").kind).toBe("allowed");
  });

  test("(U-1b) 陰性対照: 同じ人でも create_child を書かない定義では今日どおり denied", () => {
    expect(judge(NO_CC, "org_notices", { title: "告知", org: "O1" }, "assessor").kind).toBe(
      "denied",
    );
  });

  test("(U-2) 権限名を持たない人・create_child の無い名前(読むだけ)だけの人は denied", () => {
    expect(judge(M, "org_notices", { org: "O1" }, "none").kind).toBe("denied");
    expect(judge(M, "org_notices", { org: "O1" }, "viewer").kind).toBe("denied");
    // 別の組織(評価者の付与が無い)にも作れない。
    expect(judge(M, "org_notices", { org: "O2" }, "assessor").kind).toBe("denied");
  });

  test("(U-3) 上限で親の行を読めない人(読むのを止める上限)は create_child を持っていても denied", () => {
    expect(judge(M, "org_notices", { org: "O1" }, "blocked").kind).toBe("denied");
  });

  test("(U-4) 上限が親の行の書込を止めている人は、読めても create_child でも denied", () => {
    expect(judge(M, "org_notices", { org: "O1" }, "readonly").kind).toBe("denied");
  });

  test("(U-5) 名前は親の行そのもの(段0)だけ: 地域で同じ綴りの assessor を持つだけの人は、組織を読めても denied", () => {
    expect(judge(M, "org_notices", { org: "O1" }, "region_assessor").kind).toBe("denied");
  });

  test("(U-6) 行を相手にした付与(評価機関の行を経由して assessor を持つ専門家)でも作れる", () => {
    expect(judge(M, "org_notices", { org: "O1" }, "expert").kind).toBe("allowed");
  });

  test("(U-7) creatable_by が重なる: 名前が無ければ denied(名指しの権限が足りないの答えにしない)", () => {
    expect(judge(M, "org_memos", { org: "O1" }, "helper").kind).toBe("denied");
  });

  test("(U-7b) creatable_by を create_child と別の名前で満たせば作れる(親の行で org_viewer も持つ)", () => {
    expect(judge(M, "org_memos", { org: "O1" }, "both").kind).toBe("allowed");
  });

  test("(U-7c) creatable_by の照合は今日の集合のまま: 先祖(地域)の同じ綴りの名前でも満たせる", () => {
    expect(judge(M, "org_memos", { org: "O1" }, "anc").kind).toBe("allowed");
  });

  test("(U-7d) 陰性対照: 親に書ける人で名指しの権限名が無ければ今日どおり missing_named_permission", () => {
    expect(judge(M, "org_memos", { org: "O1" }, "admin").kind).toBe("missing_named_permission");
    expect(judge(NO_CC, "org_memos", { org: "O1" }, "admin").kind).toBe("missing_named_permission");
  });

  test("(U-8) create_child に名の無い兄弟の子(報告)には作れない", () => {
    expect(judge(M, "org_reports", { org: "O1" }, "assessor").kind).toBe("denied");
    expect(judge(M, "org_reports", { org: "O1" }, "admin").kind).toBe("allowed");
  });

  test("(U-9) 孫(他人の告知へのコメント)には作れない(親の告知を読めても書けない)", () => {
    expect(judge(M, "notice_comments", { notice: "N0" }, "assessor").kind).toBe("denied");
    expect(judge(M, "notice_comments", { notice: "N0" }, "admin").kind).toBe("allowed");
  });

  test("(U-10) 2つの親を持つ子は、create_child の無い側の親(評価機関)で落ちる", () => {
    expect(judge(M, "joint_notices", { org: "O1", ev: "E1" }, "expert").kind).toBe("denied");
    expect(judge(M, "joint_notices", { org: "O1", ev: "E1" }, "assessor").kind).toBe("denied");
    // 片方の親だけを書いた行は、書いた親(組織)だけを見る(空の親は今日どおり飛ばす)。
    expect(judge(M, "joint_notices", { org: "O1" }, "assessor").kind).toBe("allowed");
  });

  test("(U-11) 子の表が付与表なら、適用時の検査を通り抜けた定義でも create_child を見ない", () => {
    const raw = JSON.parse(JSON.stringify(M)) as Any;
    const tables = (raw.app as Any).tables as Any[];
    const orgs = tables.find((table) => table.id === "orgs") as Any;
    const assessor = ((orgs.access_control as Any).permissions as Any[]).find(
      (permission) => permission.id === "assessor",
    ) as Any;
    assessor.create_child = ["org_notices", "org_grants"];
    const orgGrants = tables.find((table) => table.id === "org_grants") as Any;
    orgGrants.access_control = governed(
      "notice_grants",
      "notice",
      [perm("g_admin", true, true, true)],
      "g_admin",
      { inherit_from: ["org"] },
    );
    const crafted = raw as unknown as Manifest;
    expect(
      judge(crafted, "org_grants", { org: "O1", permission: "assessor" }, "assessor").kind,
    ).toBe("denied");
    expect(judge(crafted, "org_notices", { org: "O1" }, "assessor").kind).toBe("allowed");
  });

  test("(U-12) 答えの種類を増やさない: create_child で落ちる形はどれも denied", () => {
    const kinds = new Set<string>();
    for (const [table, values, who] of [
      ["org_notices", { org: "O1" }, "none"],
      ["org_notices", { org: "O1" }, "blocked"],
      ["org_notices", { org: "O1" }, "readonly"],
      ["org_notices", { org: "O1" }, "region_assessor"],
      ["org_memos", { org: "O1" }, "helper"],
      ["org_reports", { org: "O1" }, "assessor"],
      ["notice_comments", { notice: "N0" }, "assessor"],
      ["joint_notices", { org: "O1", ev: "E1" }, "expert"],
      ["org_notices", { org: "no-such-org" }, "assessor"],
    ] as const) {
      kinds.add(judge(M, table, values, who).kind);
    }
    expect([...kinds]).toEqual(["denied"]);
  });

  test("(U-13) 親の行は2度読まない(create_child の枝でも親の行の読みは1回)", () => {
    const judged = judge(M, "org_notices", { org: "O1" }, "assessor");
    expect(judged.kind).toBe("allowed");
    expect(judged.reads.row.filter((read) => read === "orgs/O1")).toEqual(["orgs/O1"]);
  });

  test("(U-14) 宣言を見る前に行を読まない: create_child に名の無い子では、宣言の有無で読みの本数も答えも同じ", () => {
    for (const [table, values, who] of [
      ["org_reports", { org: "O1" }, "assessor"],
      ["org_reports", { org: "O1" }, "admin"],
      ["notice_comments", { notice: "N0" }, "assessor"],
      ["org_memos", { org: "O1" }, "admin"],
      ["assessments", { org: "O1" }, "viewer"],
    ] as const) {
      const declared = judge(M, table, values, who);
      const undeclared = judge(NO_CC, table, values, who);
      expect(declared, `${table} ${who}`).toEqual(undeclared);
    }
  });

  test("(U-15) 宣言の無い定義では、create_child の名の出る子でも読みの本数と答えが今日のまま(書けない人)", () => {
    const undeclared = judge(NO_CC, "org_notices", { org: "O1" }, "assessor");
    expect(undeclared.kind).toBe("denied");
    // 親の行を読み、点の判定のために表を読むだけで、create_child の照合のための読みは1本も足さない。
    const declaredForWriter = judge(M, "org_notices", { org: "O1" }, "admin");
    const undeclaredForWriter = judge(NO_CC, "org_notices", { org: "O1" }, "admin");
    expect(declaredForWriter).toEqual(undeclaredForWriter);
  });
});

// =====================================================================================
// (E) 入口ごとに1本(実 HTTP・MCP・自動処理・島・受信口・時刻起動)
// =====================================================================================

type Who = { cookie: string; userId: string; username: string };

let dataRoot: string | undefined;
let server: ReturnType<typeof createServerApp>;
let current: Manifest;
let admin: Who;
let expert: Who;
let outsider: Who;
/** 【`V23-M7-T04`】同じ組織1 に評価者として居る2人目・評価機関1 を経由する専門家2人。 */
let expert2: Who;
let pexpert: Who;
let pexpert2: Who;
let inboundEndpoint = "";
type Ids = Record<
  "mAdmin" | "mExpert" | "mOut" | "mExpert2" | "mP1" | "mP2" | "r1" | "o1" | "o2" | "e1" | "a1",
  string
>;
let ids = {} as Ids;

beforeAll(async () => {
  await ensureIslandRuntimeReady();
});

function withDb<T>(run: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot as string, APP_ID));
  try {
    return run(db);
  } finally {
    db.close();
  }
}

/** カーネルを直接呼んで1行作る(判定の外側で台を組む)。 */
function put(table: string, values: Record<string, unknown>): string {
  return withDb((db) => {
    const created = createRecord(db, current, table, values);
    if (!created.ok) {
      throw new Error(`${table} に行を置けない: ${JSON.stringify(created.errors)}`);
    }
    return String(created.value._id);
  });
}

function rowsOf(table: string): Record<string, unknown>[] {
  return withDb((db) => db.query(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[]);
}

function noticesOn(org: string): Record<string, unknown>[] {
  return rowsOf("org_notices").filter((row) => row.org === org);
}

async function makeApp(options: { createChild?: boolean; wfs?: readonly GateWf[] } = {}) {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-cc-gate-"));
  const meta = KernelMetaStore.open(dataRoot);
  try {
    createApp(meta, "子の表に行を作れる権限の関門", { app_id: APP_ID });
  } finally {
    meta.close();
  }
  current = gateManifest(options);
  const applied = applyManifest(dataRoot, APP_ID, current);
  if (!applied.valid) {
    throw new Error(JSON.stringify(applied.errors));
  }
  const seed = (username: string, role: string): Who => {
    const s = seedSession(dataRoot as string, APP_ID, { role, username });
    return { cookie: s.cookie, userId: s.userId, username };
  };
  admin = seed("admin1", "staff");
  expert = seed("expert1", "staff");
  outsider = seed("outsider1", "staff");
  expert2 = seed("expert2", "staff");
  pexpert = seed("pexpert1", "staff");
  pexpert2 = seed("pexpert2", "staff");
  const mAdmin = put("members", { name: "管理者", account: admin.userId });
  const mExpert = put("members", { name: "評価者", account: expert.userId });
  const mOut = put("members", { name: "外の人", account: outsider.userId });
  const mExpert2 = put("members", { name: "評価者2", account: expert2.userId });
  const mP1 = put("members", { name: "専門家1", account: pexpert.userId });
  const mP2 = put("members", { name: "専門家2", account: pexpert2.userId });
  const r1 = put("regions", { title: "地域1" });
  const o1 = put("orgs", { title: "組織1", region: r1 });
  const o2 = put("orgs", { title: "組織2", region: r1 });
  for (const o of [o1, o2]) {
    put("org_grants", { org: o, member: mAdmin, permission: "org_admin" });
  }
  put("org_grants", { org: o1, member: mExpert, permission: "assessor" });
  put("org_grants", { org: o1, member: mExpert2, permission: "assessor" });
  const e1 = put("evaluators", { title: "評価機関1" });
  // 評価機関1 の所属(読むだけ)2人と、組織1 で評価機関1 を相手にした assessor の付与(行を相手にした付与)。
  put("ev_grants", { ev: e1, member: mP1, permission: "ev_staff" });
  put("ev_grants", { ev: e1, member: mP2, permission: "ev_staff" });
  put("org_grants", { org: o1, evaluator: e1, permission: "assessor" });
  const a1 = put("assessments", { title: "評価1", org: o1 });
  put("assessment_grants", { assessment: a1, member: mAdmin, permission: "as_author" });
  ids = { mAdmin, mExpert, mOut, mExpert2, mP1, mP2, r1, o1, o2, e1, a1 };
  process.env[KEY_ENV_VAR] = SIGNING_KEY;
  const inbound = InboundStore.openForKernel(dataRoot);
  try {
    inboundEndpoint = inbound.issueInboundEndpoint({
      appId: APP_ID,
      name: "notices",
      secretSource: { kind: "env", value: KEY_ENV_VAR },
      targetTable: "org_notices",
    }).id;
  } finally {
    inbound.close();
  }
  server = createServerApp({ dataRoot });
}

afterEach(async () => {
  delete process.env[KEY_ENV_VAR];
  if (dataRoot !== undefined) {
    await rm(dataRoot, { recursive: true, force: true });
    dataRoot = undefined;
  }
});

type Sent = { status: number; text: string };

async function http(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  who: Who,
  options: { body?: unknown; ifMatch?: string } = {},
): Promise<Sent> {
  const headers: Record<string, string> = { cookie: who.cookie, origin: TEST_ORIGIN };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (options.ifMatch !== undefined) {
    headers["if-match"] = options.ifMatch;
  }
  const res = await server.request(
    new Request(`http://localhost/api/apps/${APP_ID}${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );
  return { status: res.status, text: await res.text() };
}

const RECORDS = (table: string) => `/tables/${table}/records`;

async function mcp(
  who: Who,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const mcpServer = createMcpServer({
    dataRoot: dataRoot as string,
    previewBaseUrl: "http://127.0.0.1:3000",
    actor: who.username,
  });
  const client = new Client({ name: "t03", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), mcpServer.connect(serverTransport)]);
  try {
    const result = (await client.callTool({
      name,
      arguments: { app_id: APP_ID, ...args },
    })) as CallToolResult;
    return { isError: result.isError === true, text: JSON.stringify(result.content) };
  } finally {
    await client.close();
    await mcpServer.close();
  }
}

async function postInbound(payload: Record<string, unknown>): Promise<Sent> {
  const rawBody = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", SIGNING_KEY).update(Buffer.from(rawBody, "utf-8")).digest("hex")}`;
  const res = await server.request(
    new Request(`http://localhost/inbound/${inboundEndpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Mock-PSP-Signature": signature },
      body: rawBody,
    }),
  );
  return { status: res.status, text: await res.text() };
}

/** きっかけの行を評価者が画面の口で作る(on_create の自動処理が同じ要求の中で走る)。 */
async function fire(who: Who, gorg: string): Promise<Sent> {
  return await http("POST", RECORDS("cmds"), who, { body: { title: "指示", gorg } });
}

/** 指示の行の「作る」ボタンを押す(手動起動。書き手は押した人)。 */
async function press(who: Who, cmd: string): Promise<Sent> {
  return await http("POST", `/views/cmd_list/actions/run?workflow=wf_manual&record=${cmd}`, who);
}

describe("V23-M7-T03 (E) 入口ごとに1本", () => {
  test("(E-1) HTTP の単件: 評価者は組織1 に告知を作れる(201)。付与の無い組織2 には 403", async () => {
    await makeApp();
    const created = await http("POST", RECORDS("org_notices"), expert, {
      body: { title: "告知", org: ids.o1 },
    });
    expect(created.status, created.text).toBe(201);
    expect(noticesOn(ids.o1)).toHaveLength(1);
    const refused = await http("POST", RECORDS("org_notices"), expert, {
      body: { title: "告知", org: ids.o2 },
    });
    expect(refused.status, refused.text).toBe(403);
    expect(noticesOn(ids.o2)).toHaveLength(0);
  });

  test("(E-1b) 陰性対照: create_child を書かないアプリでは、同じ評価者の単件の作成は今日どおり 403", async () => {
    await makeApp({ createChild: false });
    const refused = await http("POST", RECORDS("org_notices"), expert, {
      body: { title: "告知", org: ids.o1 },
    });
    expect(refused.status, refused.text).toBe(403);
    expect(noticesOn(ids.o1)).toHaveLength(0);
  });

  test("(E-1c) HTTP の単件: 評価者でも組織の行そのもの・兄弟の子(報告)には作れない(403)", async () => {
    await makeApp();
    const report = await http("POST", RECORDS("org_reports"), expert, {
      body: { title: "報告", org: ids.o1 },
    });
    expect(report.status, report.text).toBe(403);
    expect(rowsOf("org_reports")).toHaveLength(0);
  });

  test("(E-2) HTTP の一括: 評価者の告知の作成が通る", async () => {
    await makeApp();
    const sent = await http("POST", "/batch", expert, {
      body: {
        ops: [{ op: "create", table: "org_notices", values: { title: "一括", org: ids.o1 } }],
      },
    });
    expect(sent.status, sent.text).toBeLessThan(300);
    expect(noticesOn(ids.o1).map((row) => row.title)).toEqual(["一括"]);
  });

  test("(E-3) MCP の insert_sample_data: 評価者の告知が入る", async () => {
    await makeApp();
    const result = await mcp(expert, "insert_sample_data", {
      table_id: "org_notices",
      rows: [{ title: "見本", org: ids.o1 }],
    });
    expect(result.isError, result.text).toBe(false);
    expect(noticesOn(ids.o1).map((row) => row.title)).toEqual(["見本"]);
  });

  test("(E-4) MCP の write_records: 評価者の告知の作成が通る", async () => {
    await makeApp();
    const result = await mcp(expert, "write_records", {
      ops: [{ op: "create", table: "org_notices", values: { title: "道具から", org: ids.o1 } }],
    });
    expect(result.isError, result.text).toBe(false);
    expect(noticesOn(ids.o1).map((row) => row.title)).toEqual(["道具から"]);
  });

  test("(E-4b) MCP の write_records: 付与の無い組織2 には作れない", async () => {
    await makeApp();
    const result = await mcp(expert, "write_records", {
      ops: [{ op: "create", table: "org_notices", values: { title: "道具から", org: ids.o2 } }],
    });
    expect(result.isError, result.text).toBe(true);
    expect(noticesOn(ids.o2)).toHaveLength(0);
  });

  test("(E-5) 自動処理の create_record: 評価者が起こした処理で告知が作られる", async () => {
    await makeApp({ wfs: ["act"] });
    const sent = await fire(expert, ids.o1);
    expect(sent.status, sent.text).toBe(201);
    expect(noticesOn(ids.o1).map((row) => row.title)).toEqual(["自動処理から"]);
  });

  test("(E-5b) 自動処理の create_record: 付与の無い組織2 では断られ、きっかけの行ごと巻き戻る", async () => {
    await makeApp({ wfs: ["act"] });
    const sent = await fire(expert, ids.o2);
    expect(sent.status, sent.text).toBe(400);
    expect(noticesOn(ids.o2)).toHaveLength(0);
    expect(rowsOf("cmds")).toHaveLength(0);
  });

  test("(E-6) 島の write_ops: 評価者が起こした島が告知を作れる", async () => {
    await makeApp({ wfs: ["isl"] });
    const sent = await fire(expert, ids.o1);
    expect(sent.status, sent.text).toBe(201);
    expect(noticesOn(ids.o1).map((row) => row.title)).toEqual(["島から"]);
  });

  test("(E-7) 島の output_table: 評価者が起こした作り直しで告知が作られる(作り直す前の行は0件)", async () => {
    await makeApp({ wfs: ["replace"] });
    const sent = await fire(expert, ids.o1);
    expect(sent.status, sent.text).toBe(201);
    expect(noticesOn(ids.o1).map((row) => row.title)).toEqual(["置き換え"]);
  });

  test("(E-8) 受信口は通らない(書き手が名簿に居ない)。1行も増えない", async () => {
    await makeApp();
    const sent = await postInbound({ event_id: "evt-1", title: "外から", org: ids.o1 });
    expect(sent.status, sent.text).toBeGreaterThanOrEqual(400);
    expect(noticesOn(ids.o1)).toHaveLength(0);
  });

  test("(E-9)【正直に書く】時刻起動は今日どおり素通しで、付与の無い組織2 にも告知が作られる", async () => {
    await makeApp({ wfs: ["sched"] });
    const cmd = put("cmds", { title: "夜間", gorg: ids.o2 });
    withDb((db) => {
      const workflow = (current.app.workflows ?? []).find((w) => w.id === "wf_sched");
      runScheduledWorkflow(db, current, workflow as never, {
        records: [rowsOf("cmds").find((row) => row._id === cmd) as never],
      });
    });
    expect(noticesOn(ids.o2).map((row) => row.title)).toEqual(["時刻起動から"]);
  });

  test("(E-10) D-V23-259: 手動起動(画面のボタン)の create_record: 評価者は組織1 に作れ、付与の無い組織2 では failures で作れない", async () => {
    await makeApp({ wfs: ["manual"] });
    const ok = await press(expert, put("cmds", { title: "ボタン", gorg: ids.o1 }));
    expect(ok.status, ok.text).toBe(200);
    expect((JSON.parse(ok.text) as { failures: string[] }).failures).toEqual([]);
    expect(noticesOn(ids.o1).map((row) => row.title)).toEqual(["ボタンから"]);
    const refused = await press(expert, put("cmds", { title: "ボタン", gorg: ids.o2 }));
    expect(refused.status, refused.text).toBe(200);
    expect(refused.text).toContain("元になる行に書き込める人だけが作れます");
    expect(noticesOn(ids.o2)).toHaveLength(0);
  });

  test("(E-10b) D-V23-259: 陰性対照: create_child を書かないアプリでは、同じ評価者のボタンは組織1 でも failures で作れない", async () => {
    await makeApp({ createChild: false, wfs: ["manual"] });
    const refused = await press(expert, put("cmds", { title: "ボタン", gorg: ids.o1 }));
    expect(refused.status, refused.text).toBe(200);
    expect(refused.text).toContain("元になる行に書き込める人だけが作れます");
    expect(noticesOn(ids.o1)).toHaveLength(0);
  });
});

// =====================================================================================
// 【V23-M7-T04】作った人への付与と受け入れ基準(要件書 FR-5)
// =====================================================================================

function versionOf(table: string, id: string): string {
  return String(rowsOf(table).find((row) => row._id === id)?._updated_at);
}

async function patch(who: Who, table: string, id: string, changes: Record<string, unknown>) {
  return await http("PATCH", `${RECORDS(table)}/${id}`, who, {
    body: changes,
    ifMatch: versionOf(table, id),
  });
}

/** その告知に付いた付与の行(`member` と `permission`)。 */
function grantsOf(noticeId: string): { member: unknown; permission: unknown }[] {
  return rowsOf("notice_grants")
    .filter((row) => row.notice === noticeId)
    .map((row) => ({ member: row.member, permission: row.permission }));
}

/** 組織1 の告知のうち、件名がちょうど `title` の1行の id。 */
function noticeIdOf(title: string): string {
  const found = noticesOn(ids.o1).filter((row) => row.title === title);
  expect(found, JSON.stringify(rowsOf("org_notices"))).toHaveLength(1);
  return String(found[0]?._id);
}

async function createAs(who: Who, title: string): Promise<string> {
  const created = await http("POST", RECORDS("org_notices"), who, {
    body: { title, org: ids.o1 },
  });
  expect(created.status, created.text).toBe(201);
  return noticeIdOf(title);
}

describe("V23-M7-T04 (C) 作った人に子の creator_permission が入る(作成の入口ごと)", () => {
  test("(C-1) HTTP の単件", async () => {
    await makeApp();
    const id = await createAs(expert, "単件");
    expect(grantsOf(id)).toEqual([{ member: ids.mExpert, permission: "author" }]);
  });

  test("(C-2) HTTP の一括", async () => {
    await makeApp();
    const sent = await http("POST", "/batch", expert, {
      body: {
        ops: [{ op: "create", table: "org_notices", values: { title: "一括", org: ids.o1 } }],
      },
    });
    expect(sent.status, sent.text).toBeLessThan(300);
    expect(grantsOf(noticeIdOf("一括"))).toEqual([{ member: ids.mExpert, permission: "author" }]);
  });

  test("(C-3) MCP の insert_sample_data", async () => {
    await makeApp();
    const result = await mcp(expert, "insert_sample_data", {
      table_id: "org_notices",
      rows: [{ title: "見本", org: ids.o1 }],
    });
    expect(result.isError, result.text).toBe(false);
    expect(grantsOf(noticeIdOf("見本"))).toEqual([{ member: ids.mExpert, permission: "author" }]);
  });

  test("(C-4) MCP の write_records", async () => {
    await makeApp();
    const result = await mcp(expert, "write_records", {
      ops: [{ op: "create", table: "org_notices", values: { title: "道具から", org: ids.o1 } }],
    });
    expect(result.isError, result.text).toBe(false);
    expect(grantsOf(noticeIdOf("道具から"))).toEqual([
      { member: ids.mExpert, permission: "author" },
    ]);
  });

  // 【正直に書く】自動処理・島が作った行には、今日、作成者への付与を1件も書かない(作成者付与を書くのは
  // 画面と HTTP の単件・一括と MCP の2口だけ。`create_child` で通った作成も同じ)。 したがって評価者が自動処理で
  // 作った告知は、評価者が直せない(組織の assessor で読めるだけ)。 この段では振る舞いを変えず、今日の姿を固定する。
  test("(C-5)【正直に書く】自動処理の create_record: 告知は作られるが、作成者への付与は入らない(直せない)", async () => {
    await makeApp({ wfs: ["act"] });
    const sent = await fire(expert, ids.o1);
    expect(sent.status, sent.text).toBe(201);
    const id = noticeIdOf("自動処理から");
    expect(grantsOf(id)).toEqual([]);
    const read = await http("GET", `${RECORDS("org_notices")}/${id}`, expert);
    expect(read.status, read.text).toBe(200);
    const updated = await patch(expert, "org_notices", id, { title: "直したい" });
    expect(updated.status, updated.text).toBe(403);
  });

  test("(C-6)【正直に書く】島の write_ops: 告知は作られるが、作成者への付与は入らない", async () => {
    await makeApp({ wfs: ["isl"] });
    const sent = await fire(expert, ids.o1);
    expect(sent.status, sent.text).toBe(201);
    expect(grantsOf(noticeIdOf("島から"))).toEqual([]);
  });

  test("(C-7)【正直に書く】島の output_table: 告知は作られるが、作成者への付与は入らない", async () => {
    await makeApp({ wfs: ["replace"] });
    const sent = await fire(expert, ids.o1);
    expect(sent.status, sent.text).toBe(201);
    expect(grantsOf(noticeIdOf("置き換え"))).toEqual([]);
  });

  test("(C-8) 陰性対照: 組織に書ける管理者が自動処理で作っても、作成者への付与は入らない(create_child と関係なく今日の姿)", async () => {
    await makeApp({ wfs: ["act"] });
    const sent = await fire(admin, ids.o1);
    expect(sent.status, sent.text).toBe(201);
    expect(grantsOf(noticeIdOf("自動処理から"))).toEqual([]);
  });

  test("(C-9) D-V23-259: 作成者付与 × 手動起動: ボタンで作った告知に作成者への付与は入らない(同じ人の画面の単件には入る)", async () => {
    await makeApp({ wfs: ["manual"] });
    const sent = await press(expert, put("cmds", { title: "ボタン", gorg: ids.o1 }));
    expect(sent.status, sent.text).toBe(200);
    expect(grantsOf(noticeIdOf("ボタンから"))).toEqual([]);
    // 陽性対照: 同じ評価者が画面の単件で作ると、作成者への付与が1件入る。
    const id = await createAs(expert, "単件");
    expect(grantsOf(id)).toEqual([{ member: ids.mExpert, permission: "author" }]);
  });

  test("(C-10) D-V23-259: 作成者付与 × 時刻起動: 時刻起動で作った告知に作成者への付与は入らない(同じ人の画面の単件には入る)", async () => {
    await makeApp({ wfs: ["sched"] });
    const cmd = put("cmds", { title: "夜間", gorg: ids.o1 });
    withDb((db) => {
      const workflow = (current.app.workflows ?? []).find((w) => w.id === "wf_sched");
      runScheduledWorkflow(db, current, workflow as never, {
        records: [rowsOf("cmds").find((row) => row._id === cmd) as never],
      });
    });
    expect(grantsOf(noticeIdOf("時刻起動から"))).toEqual([]);
    expect(rowsOf("notice_grants")).toHaveLength(0);
    const id = await createAs(expert, "単件");
    expect(grantsOf(id)).toEqual([{ member: ids.mExpert, permission: "author" }]);
  });
});

describe("V23-M7-T04 (A) 受け入れ基準: 自分の告知は直せ、他人の告知は読むだけ。組織と評価は直せない", () => {
  test("(A-1) 自分の告知は更新できる(200)", async () => {
    await makeApp();
    const id = await createAs(expert, "自分の");
    const sent = await patch(expert, "org_notices", id, { title: "直した" });
    expect(sent.status, sent.text).toBe(200);
    expect(rowsOf("org_notices").find((row) => row._id === id)?.title).toBe("直した");
  });

  test("(A-2) 自分の告知は削除できる", async () => {
    await makeApp();
    const id = await createAs(expert, "消す");
    const sent = await http("DELETE", `${RECORDS("org_notices")}/${id}`, expert, {
      ifMatch: versionOf("org_notices", id),
    });
    expect(sent.status, sent.text).toBeLessThan(300);
    expect(rowsOf("org_notices").some((row) => row._id === id)).toBe(false);
  });

  test("(A-3) 同じ組織の他の評価者の告知は読めるが、更新・削除は 403(行は変わらない)", async () => {
    await makeApp();
    const id = await createAs(expert, "他人の");
    const read = await http("GET", `${RECORDS("org_notices")}/${id}`, expert2);
    expect(read.status, read.text).toBe(200);
    const updated = await patch(expert2, "org_notices", id, { title: "書き換え" });
    expect(updated.status, updated.text).toBe(403);
    const deleted = await http("DELETE", `${RECORDS("org_notices")}/${id}`, expert2, {
      ifMatch: versionOf("org_notices", id),
    });
    expect(deleted.status, deleted.text).toBe(403);
    expect(rowsOf("org_notices").find((row) => row._id === id)?.title).toBe("他人の");
  });

  test("(A-4) 組織の行と評価の行は、読めるが更新は 403", async () => {
    await makeApp();
    await createAs(expert, "作った後");
    const orgRead = await http("GET", `${RECORDS("orgs")}/${ids.o1}`, expert);
    expect(orgRead.status, orgRead.text).toBe(200);
    const org = await patch(expert, "orgs", ids.o1, { title: "書き換え" });
    expect(org.status, org.text).toBe(403);
    const assessmentRead = await http("GET", `${RECORDS("assessments")}/${ids.a1}`, expert);
    expect(assessmentRead.status, assessmentRead.text).toBe(200);
    const assessment = await patch(expert, "assessments", ids.a1, { title: "書き換え" });
    expect(assessment.status, assessment.text).toBe(403);
    expect(rowsOf("orgs").find((row) => row._id === ids.o1)?.title).toBe("組織1");
    expect(rowsOf("assessments").find((row) => row._id === ids.a1)?.title).toBe("評価1");
  });

  test("(A-5) 親への権限は1つも増えない(組織の付与の行も、組織に作れる子も、作る前と同じ)", async () => {
    await makeApp();
    const before = rowsOf("org_grants");
    await createAs(expert, "増えない");
    expect(rowsOf("org_grants")).toEqual(before);
    const report = await http("POST", RECORDS("org_reports"), expert, {
      body: { title: "報告", org: ids.o1 },
    });
    expect(report.status, report.text).toBe(403);
    const assessment = await http("POST", RECORDS("assessments"), expert, {
      body: { title: "評価", org: ids.o1 },
    });
    expect(assessment.status, assessment.text).toBe(403);
  });

  test("(A-6) 行を相手にした付与で作った専門家にも author が入り直せる。同じ機関の他の専門家は読むだけ", async () => {
    await makeApp();
    const id = await createAs(pexpert, "機関から");
    expect(grantsOf(id)).toEqual([{ member: ids.mP1, permission: "author" }]);
    const own = await patch(pexpert, "org_notices", id, { title: "機関から直した" });
    expect(own.status, own.text).toBe(200);
    const read = await http("GET", `${RECORDS("org_notices")}/${id}`, pexpert2);
    expect(read.status, read.text).toBe(200);
    const other = await patch(pexpert2, "org_notices", id, { title: "書き換え" });
    expect(other.status, other.text).toBe(403);
    expect(rowsOf("org_notices").find((row) => row._id === id)?.title).toBe("機関から直した");
  });

  test("(A-7) 作成と作成者付与は同じトランザクション: 付与の書込が落ちれば告知も残らない", async () => {
    await makeApp();
    withDb((db) => {
      db.exec(
        `CREATE TRIGGER t04_break_grant BEFORE INSERT ON "notice_grants" BEGIN SELECT RAISE(ABORT, 't04 grant broken'); END`,
      );
    });
    const sent = await http("POST", RECORDS("org_notices"), expert, {
      body: { title: "残らない", org: ids.o1 },
    });
    expect(sent.status, sent.text).toBe(500);
    expect(noticesOn(ids.o1)).toHaveLength(0);
    expect(rowsOf("notice_grants")).toHaveLength(0);
  });
});

// =====================================================================================
// 【V23-M7-T05】付け替えに使えない(D-V23-178)
// =====================================================================================

/**
 * 付け替えの題材: 評価者が管理者を持つ組織3 を足し、組織2 にも評価者として入れる。 評価者が組織3 に作った告知
 * (作成者付与で author。組織3 の管理者なので古い親の消す権限もある)を、組織2(create_child だけ)へ移そうとする。
 */
function reparentRig(): { o3: string; notice: string } {
  const o3 = put("orgs", { title: "組織3", region: ids.r1 });
  put("org_grants", { org: o3, member: ids.mExpert, permission: "org_admin" });
  put("org_grants", { org: ids.o2, member: ids.mExpert, permission: "assessor" });
  const notice = put("org_notices", { title: "組織3 の告知", org: o3 });
  put("notice_grants", { notice, member: ids.mExpert, permission: "author" });
  return { o3, notice };
}

function orgOf(noticeId: string): unknown {
  return rowsOf("org_notices").find((row) => row._id === noticeId)?.org ?? null;
}

describe("V23-M7-T05 (R) create_child だけの親へは付け替えられない(更新の4入口)", () => {
  test("(R-0) 題材の確かめ: 評価者は組織2 に告知を作れる(create_child)・組織3 の告知を直せる", async () => {
    await makeApp();
    const { notice } = reparentRig();
    const created = await http("POST", RECORDS("org_notices"), expert, {
      body: { title: "組織2 へ", org: ids.o2 },
    });
    expect(created.status, created.text).toBe(201);
    const edited = await patch(expert, "org_notices", notice, { title: "直した" });
    expect(edited.status, edited.text).toBe(200);
  });

  test("(R-1) PATCH: 組織3 の告知を組織2 へ移すと 403、親は変わらない", async () => {
    await makeApp();
    const { o3, notice } = reparentRig();
    const sent = await patch(expert, "org_notices", notice, { org: ids.o2 });
    expect(sent.status, sent.text).toBe(403);
    expect(orgOf(notice)).toBe(o3);
  });

  test("(R-2) 一括の update: 403、1行も変わらない", async () => {
    await makeApp();
    const { o3, notice } = reparentRig();
    const sent = await http("POST", "/batch", expert, {
      body: {
        ops: [
          {
            op: "update",
            table: "org_notices",
            target: notice,
            if_match: versionOf("org_notices", notice),
            values: { org: ids.o2 },
          },
        ],
      },
    });
    expect(sent.status, sent.text).toBe(403);
    expect(orgOf(notice)).toBe(o3);
  });

  test("(R-3) MCP の update_record: 断られ、親は変わらない", async () => {
    await makeApp();
    const { o3, notice } = reparentRig();
    const moved = await mcp(expert, "update_record", {
      table_id: "org_notices",
      record_id: notice,
      if_match: versionOf("org_notices", notice),
      changes: { org: ids.o2 },
    });
    expect(moved.isError, moved.text).toBe(true);
    expect(orgOf(notice)).toBe(o3);
  });

  test("(R-4) MCP の write_records の update: 断られ、親は変わらない", async () => {
    await makeApp();
    const { o3, notice } = reparentRig();
    const moved = await mcp(expert, "write_records", {
      ops: [
        {
          op: "update",
          table: "org_notices",
          target: notice,
          if_match: versionOf("org_notices", notice),
          values: { org: ids.o2 },
        },
      ],
    });
    expect(moved.isError, moved.text).toBe(true);
    expect(orgOf(notice)).toBe(o3);
  });

  test("(R-5) 空の親から付ける更新も 403(親の無い告知に組織2 を書く)", async () => {
    await makeApp();
    reparentRig();
    const created = await http("POST", RECORDS("org_notices"), expert, {
      body: { title: "親なし" },
    });
    expect(created.status, created.text).toBe(201);
    const id = String(rowsOf("org_notices").find((row) => row.title === "親なし")?._id);
    expect(grantsOf(id)).toEqual([{ member: ids.mExpert, permission: "author" }]);
    const sent = await patch(expert, "org_notices", id, { org: ids.o2 });
    expect(sent.status, sent.text).toBe(403);
    expect(orgOf(id)).toBe(null);
  });

  test("(R-6) 陰性対照: 新しい親(組織2)に書ける人の付け替えは今日どおり通る", async () => {
    await makeApp();
    const { notice } = reparentRig();
    // 評価者に組織2 の管理者も渡すと、新しい親に書けるので通る(今日の付け替えの規則のまま)。
    put("org_grants", { org: ids.o2, member: ids.mExpert, permission: "org_admin" });
    const sent = await patch(expert, "org_notices", notice, { org: ids.o2 });
    expect(sent.status, sent.text).toBe(200);
    expect(orgOf(notice)).toBe(ids.o2);
  });
});

describe("V23-M7-T05 (U) 関門の述語(更新前の行を渡す経路)", () => {
  test("(U-R1) 更新前の行を渡すと、create_child だけの新しい親には denied(付け替え・空の親から付ける更新)", () => {
    const rows = memoryRows();
    rows.org_grants?.push({ _id: "x1", org: "O2", member: "m_assessor", permission: "org_admin" });
    rows.org_notices?.push({ _id: "N2", title: "組織2 の告知", org: "O2" });
    // 組織2 から組織1(create_child だけ)へ: 古い親(組織2)は管理者なので消せる。 新しい親で落ちる。
    expect(
      judge(M, "org_notices", { org: "O1" }, "assessor", rows, { _id: "N2", org: "O2" }).kind,
    ).toBe("denied");
    // 空の親から組織1 へ。
    expect(
      judge(M, "org_notices", { org: "O1" }, "assessor", rows, { _id: "N3", org: null }).kind,
    ).toBe("denied");
    // 同じ値の送り直しは今日どおり通る(親を1文字も変えない)。
    expect(
      judge(M, "org_notices", { org: "O1", title: "x" }, "assessor", rows, { _id: "N4", org: "O1" })
        .kind,
    ).toBe("allowed");
  });
});

// =====================================================================================
// 【`V23-M7-T05b`】(D) 出し分け: 行ごとの判定の5つ目のキー `create_child`
// (`ADR-0542` §Decision 4-5・限定5・限定7。決定 `D-V23-184`・`D-V23-188`・`D-V23-189`・`D-V23-192`)
//
// 測るもの: 親の表の権限のどれかが `create_child` を宣言しているときだけ、行ごとの判定に5つ目のキーが載り、
// 鍵は宣言に名の出る子の表 ID、値は作成の関門がその行で通るか(write で通るものも真。上限・読めない・行が無いは偽)。
// 一覧と1行で同じ値。 宣言の無い表・宣言の無いアプリでは4キーのまま。 MCP の list_records は1バイトも変わらない。
// 測らないもの: 画面(`web/test/create-child-screen.test.tsx`)。 性能と応答の太り(`T08b`)。
// =====================================================================================

type ChildJudge = ((row: Record<string, unknown>) => boolean) & {
  readonly createChild?: (row: Record<string, unknown>) => Readonly<Record<string, boolean>>;
};

function childOf(manifest: Manifest, who: string, rowId: string): unknown {
  const rows = memoryRows();
  const judged = rowGrantWriteJudge({
    manifest,
    tableId: "orgs",
    actorId: `u_${who}`,
    roles: null,
    readRows: (id) => rows[id] ?? [],
  }) as ChildJudge;
  const row = (rows.orgs ?? []).find((candidate) => candidate._id === rowId) ?? { _id: rowId };
  return judged.createChild === undefined ? undefined : judged.createChild(row);
}

describe("V23-M7-T05b (D) 行ごとの判定の5つ目のキー(表示用の判定)", () => {
  test("(D-1) 評価者: 組織1 では create_child に名の出る告知と共同の告知が真、覚え書き(creatable_by)は偽", () => {
    expect(childOf(M, "assessor", "O1")).toEqual({
      org_notices: true,
      joint_notices: true,
      org_memos: false,
    });
  });

  test("(D-2) 付与の無い組織2・権限名の無い人・上限で読めない人・上限で書けない人は全部偽(fail-closed)", () => {
    const allFalse = { org_notices: false, joint_notices: false, org_memos: false };
    expect(childOf(M, "assessor", "O2")).toEqual(allFalse);
    expect(childOf(M, "none", "O1")).toEqual(allFalse);
    expect(childOf(M, "blocked", "O1")).toEqual(allFalse);
    expect(childOf(M, "readonly", "O1")).toEqual(allFalse);
    // 段0 だけ: 地域で assessor を持つだけの人も偽。
    expect(childOf(M, "region_assessor", "O1")).toEqual(allFalse);
  });

  test("(D-3) write で通るものも真(管理者)。creatable_by を満たさなければ書けても偽", () => {
    expect(childOf(M, "admin", "O1")).toEqual({
      org_notices: true,
      joint_notices: true,
      org_memos: false,
    });
  });

  test("(D-4) 行を相手にした付与の専門家も真。creatable_by を別の名前で満たす人は覚え書きが真", () => {
    expect(childOf(M, "expert", "O1")).toEqual({
      org_notices: true,
      joint_notices: true,
      org_memos: false,
    });
    expect(childOf(M, "both", "O1")).toEqual({
      org_notices: false,
      joint_notices: false,
      org_memos: true,
    });
  });

  test("(D-5) 行が無い(_id の無い行)は全部偽", () => {
    const rows = memoryRows();
    const judged = rowGrantWriteJudge({
      manifest: M,
      tableId: "orgs",
      actorId: "u_assessor",
      roles: null,
      readRows: (id) => rows[id] ?? [],
    }) as ChildJudge;
    expect(judged.createChild?.({ title: "id の無い行" })).toEqual({
      org_notices: false,
      joint_notices: false,
      org_memos: false,
    });
  });

  test("(D-6) 陰性対照: 宣言の無い表(地域)と、create_child を書かない定義の組織には5つ目を求める関数が無い", () => {
    const rows = memoryRows();
    const regions = rowGrantWriteJudge({
      manifest: M,
      tableId: "regions",
      actorId: "u_assessor",
      roles: null,
      readRows: (id) => rows[id] ?? [],
    }) as ChildJudge;
    expect(regions.createChild).toBeUndefined();
    expect(childOf(NO_CC, "assessor", "O1")).toBeUndefined();
  });
});

// =====================================================================================
// 【`V23-M7-T09` 独立点検の処置。決定 `D-V23-200`】読む条件・上限の要素の重ね・項目の全部、に歯を付ける
//
// 測るもの: (1) 上限の無い `read: false` の権限名に `create_child` を書き、その名前だけを持つ人は、
// 上限が書込を止めていなくても作れない(親の行を読めない。決定 `D-V23-181`)。 関門と表示用の判定の両方。
// (2) 上限の要素に書いた `create_child` は数えない(適用時の検査を経ない定義を直に渡す)。
// (3) 同じ親を指す `inherit_from` の項目が2つある子では、表示用の判定は項目の全部で関門が通るときだけ真
// (適用時の検査を経ない定義と、1つ目の項目の関門の後で付与が見えなくなる読み手を直に渡す)。
// 既存の題材 `M` と行 `memoryRows()` は1文字も変えず、写しに足す。
// =====================================================================================

/** `M` の写しの組織の権限に `extra` を足す(`M` は変えない)。 */
function withOrgPermissions(extra: Any[]): Manifest {
  const raw = JSON.parse(JSON.stringify(M)) as Any;
  const orgs = ((raw.app as Any).tables as Any[]).find((table) => table.id === "orgs") as Any;
  ((orgs.access_control as Any).permissions as Any[]).push(...extra);
  return raw as unknown as Manifest;
}

/** `memoryRows()` に人を1人と、組織1 での付与を足す。 */
function rowsWithPerson(who: string, permissions: string[]): Rows {
  const rows = memoryRows();
  rows.members?.push({ _id: `m_${who}`, name: who, account: `u_${who}` });
  for (const permission of permissions) {
    rows.org_grants?.push({
      _id: `org-${who}-${permission}`,
      org: "O1",
      member: `m_${who}`,
      permission,
    });
  }
  return rows;
}

function childOfRows(manifest: Manifest, who: string, rows: Rows): unknown {
  const judged = rowGrantWriteJudge({
    manifest,
    tableId: "orgs",
    actorId: `u_${who}`,
    roles: null,
    readRows: (id) => rows[id] ?? [],
  }) as ChildJudge;
  const row = (rows.orgs ?? []).find((candidate) => candidate._id === "O1") ?? { _id: "O1" };
  return judged.createChild === undefined ? undefined : judged.createChild(row);
}

describe("V23-M7-T09 (U) 読む条件だけを撃つ題材(上限の無い read: false の権限名)", () => {
  const POSTER = withOrgPermissions([
    perm("poster", false, false, false, { create_child: ["org_notices"] }),
  ]);
  const READABLE_POSTER = withOrgPermissions([
    perm("poster", true, false, false, { create_child: ["org_notices"] }),
  ]);
  const rows = rowsWithPerson("poster", ["poster"]);

  test("(U-16) read: false の名前だけを持つ人は、上限が無くても create_child で作れない(denied)", () => {
    expect(judge(POSTER, "org_notices", { org: "O1" }, "poster", rows).kind).toBe("denied");
  });

  test("(U-16b) 陰性対照: 同じ名前を read: true にすれば作れる(落ちた理由は読めないことだけ)", () => {
    expect(judge(READABLE_POSTER, "org_notices", { org: "O1" }, "poster", rows).kind).toBe(
      "allowed",
    );
  });

  test("(D-7) 表示用の判定も、read: false の名前だけを持つ人には偽(read: true にすれば真)", () => {
    expect(childOfRows(POSTER, "poster", rows)).toEqual({
      org_notices: false,
      joint_notices: false,
      org_memos: false,
    });
    expect(childOfRows(READABLE_POSTER, "poster", rows)).toEqual({
      org_notices: true,
      joint_notices: false,
      org_memos: false,
    });
  });
});

describe("V23-M7-T09 (U) 適用時の検査を経ない定義を直に渡す(上限の要素・項目の全部)", () => {
  test("(U-17) 上限の要素(restrictive)に書いた create_child は数えない: 読めて上限が書込を止めていなくても denied", () => {
    // 今日の判定では、上限の要素は自分の動詞を1段目にも入れるので、正しい読み手からはこの重ねに届かない
    // (書ける上限なら書込で通り、書けない上限なら上限が書込を止める)。 そこで、親の行の読み書きを解く間は
    // 付与が org_viewer だけに見え、名前を集める段で上限の要素 cap_cc も見える読み手を直に渡す。
    const define = (restrictive: boolean) =>
      withOrgPermissions([
        perm("cap_cc", true, false, false, {
          ...(restrictive ? { restrictive: true } : {}),
          create_child: ["org_notices"],
        }),
      ]);
    const before = rowsWithPerson("capper", ["org_viewer"]);
    const after = rowsWithPerson("capper", ["org_viewer", "cap_cc"]);
    const run = (manifest: Manifest, limit: number) => {
      let grantReads = 0;
      const pick = (id: string): Record<string, unknown>[] => {
        if (id !== "org_grants") return before[id] ?? [];
        grantReads += 1;
        return (grantReads > limit ? after : before)[id] ?? [];
      };
      const verdict = judgeCreateParentAccess({
        manifest,
        tableId: "org_notices",
        values: { org: "O1" },
        actorId: "u_capper",
        readRows: pick,
        readRow: (id, recordId) => (before[id] ?? []).find((row) => row._id === recordId),
      });
      return { kind: verdict.kind, grantReads };
    };
    // 親の行の読み書きを解くまでの付与表の読みの回数を、書ける人(名前を集める段に進まない)で測る。
    let adminReads = 0;
    judgeCreateParentAccess({
      manifest: define(true),
      tableId: "org_notices",
      values: { org: "O1" },
      actorId: "u_admin",
      readRows: (id) => {
        if (id === "org_grants") adminReads += 1;
        return before[id] ?? [];
      },
      readRow: (id, recordId) => (before[id] ?? []).find((row) => row._id === recordId),
    });
    expect(adminReads).toBeGreaterThan(0);
    // 陰性対照: 上限の印の無い同じ名前なら、この読み手で作れる(名前を集める段で cap_cc が数えられる)。
    expect(run(define(false), adminReads).kind).toBe("allowed");
    // 上限の印のある名前は数えない。
    expect(run(define(true), adminReads).kind).toBe("denied");
  });

  test("(D-8) 同じ親を指す項目が2つある子: 2つ目の項目の関門で落ちれば偽(項目の全部で通るときだけ真)", () => {
    // 組織の宣言で create_child を名指すのは評価者の告知だけにし、告知に組織を指す2つ目の項目を足す。
    const raw = JSON.parse(JSON.stringify(M)) as Any;
    const tables = (raw.app as Any).tables as Any[];
    const orgs = tables.find((table) => table.id === "orgs") as Any;
    for (const permission of (orgs.access_control as Any).permissions as Any[]) {
      if (permission.id === "assessor") permission.create_child = ["org_notices"];
      if (permission.id === "helper") delete permission.create_child;
    }
    const single = JSON.parse(JSON.stringify(raw)) as unknown as Manifest;
    const notices = tables.find((table) => table.id === "org_notices") as Any;
    (notices.fields as Any[]).push(ref("org2", "orgs"));
    (notices.access_control as Any).inherit_from = ["org", "org2"];
    const twoFields = raw as unknown as Manifest;

    const base = memoryRows();
    const row = (base.orgs ?? []).find((candidate) => candidate._id === "O1") ?? { _id: "O1" };
    // 読み手: 行の判定を始めてから組織の付与表を読んだ回数を数え、`limit` 回を越えたら付与を1行も返さない。
    const run = (manifest: Manifest, limit: number) => {
      let grantReads = 0;
      let counting = false;
      const judged = rowGrantWriteJudge({
        manifest,
        tableId: "orgs",
        actorId: "u_assessor",
        roles: null,
        readRows: (id) => {
          if (id === "org_grants" && counting) {
            grantReads += 1;
            if (grantReads > limit) return [];
          }
          return base[id] ?? [];
        },
      }) as ChildJudge;
      counting = true;
      const answer = judged.createChild?.(row);
      return { answer, grantReads };
    };
    // 1つ目の項目だけの子で、関門1回あたりの付与表の読みの回数を測る。
    const once = run(single, Number.POSITIVE_INFINITY);
    expect(once.answer).toEqual({ org_notices: true });
    expect(once.grantReads).toBeGreaterThan(0);
    // 陰性対照: 読み手が変わらなければ、2つの項目でも真(2つとも関門を通す)。
    const stable = run(twoFields, Number.POSITIVE_INFINITY);
    expect(stable.answer).toEqual({ org_notices: true });
    expect(stable.grantReads).toBe(once.grantReads * 2);
    // 1つ目の項目の関門の後で付与が見えなくなる読み手では、2つ目の項目で落ちるので偽。
    expect(run(twoFields, once.grantReads).answer).toEqual({ org_notices: false });
  });
});

type ListBody = { records: Any[]; access?: Record<string, Any> };

async function listAccess(who: Who, table: string): Promise<Record<string, Any>> {
  const sent = await http("GET", RECORDS(table), who);
  expect(sent.status, sent.text).toBe(200);
  return (JSON.parse(sent.text) as ListBody).access ?? {};
}

async function singleAccess(who: Who, table: string, id: string): Promise<Any | undefined> {
  const sent = await http("GET", `${RECORDS(table)}/${id}`, who);
  expect(sent.status, sent.text).toBe(200);
  return (JSON.parse(sent.text) as { access?: Record<string, Any> }).access?.[id];
}

/** 応答の `access` の値から5つ目のキーを外した本文(陰性対照の比べ方)。 */
function withoutCreateChild(text: string): string {
  const body = JSON.parse(text) as { access?: Record<string, Any> };
  for (const value of Object.values(body.access ?? {})) {
    delete value.create_child;
  }
  return JSON.stringify(body);
}

describe("V23-M7-T05b (H) 一覧と1行の応答", () => {
  test("(H-1) 一覧: 評価者の組織1 の行に5つ目のキーが載る(鍵は宣言に名の出る子の表 ID)", async () => {
    await makeApp();
    const access = await listAccess(expert, "orgs");
    expect(access[ids.o1]).toEqual({
      read: true,
      write: false,
      delete: false,
      grant_write: false,
      create_child: { org_notices: true, joint_notices: true, org_memos: false },
    });
  });

  test("(H-2) 管理者は write で通るので真。付与の無い人の行は(読めれば)偽", async () => {
    await makeApp();
    const access = await listAccess(admin, "orgs");
    expect(access[ids.o1]?.create_child).toEqual({
      org_notices: true,
      joint_notices: true,
      org_memos: false,
    });
    expect(access[ids.o2]?.create_child).toEqual({
      org_notices: true,
      joint_notices: true,
      org_memos: false,
    });
    // 評価者は組織2 を読めないので一覧に出ない(5つ目のキーの有無で行を増やさない)。
    const forExpert = await listAccess(expert, "orgs");
    expect(Object.keys(forExpert)).toEqual([ids.o1]);
  });

  test("(H-3) 1行(詳細)と一覧で同じ値(同じ1本を通る)", async () => {
    await makeApp();
    for (const who of [expert, admin, pexpert]) {
      const list = await listAccess(who, "orgs");
      expect(await singleAccess(who, "orgs", ids.o1), who.username).toEqual(list[ids.o1]);
    }
  });

  test("(H-4) 宣言の無い表(地域・告知・評価)の行は4キーのまま", async () => {
    await makeApp();
    await http("POST", RECORDS("org_notices"), expert, { body: { title: "告知", org: ids.o1 } });
    // 地域の行を管理者が読めるように地域の付与を1行置く(題材の台は地域の付与を持たない)。
    put("region_grants", { region: ids.r1, member: ids.mAdmin, permission: "region_admin" });
    for (const table of ["regions", "org_notices", "assessments"]) {
      const access = await listAccess(admin, table);
      expect(Object.keys(access).length, table).toBeGreaterThan(0);
      for (const value of Object.values(access)) {
        expect(Object.keys(value), table).toEqual(["read", "write", "delete", "grant_write"]);
      }
    }
  });

  test("(H-5) 陰性対照: create_child を書かないアプリでは組織の行も4キーで、外した本文と1バイトも違わない", async () => {
    await makeApp();
    const declared = {
      list: (await http("GET", RECORDS("orgs"), expert)).text,
      single: (await http("GET", `${RECORDS("orgs")}/${ids.o1}`, expert)).text,
    };
    const applied = applyManifest(dataRoot as string, APP_ID, NO_CC);
    expect(applied.valid, JSON.stringify(applied)).toBe(true);
    current = NO_CC;
    const list = await http("GET", RECORDS("orgs"), expert);
    const single = await http("GET", `${RECORDS("orgs")}/${ids.o1}`, expert);
    expect(list.text).not.toContain("create_child");
    expect(single.text).not.toContain("create_child");
    expect(list.text).toBe(withoutCreateChild(declared.list));
    expect(single.text).toBe(withoutCreateChild(declared.single));
    expect(declared.list).toContain("create_child");
  });

  test("(H-6) MCP の list_records は5つ目のキーを載せない: 宣言の有無で応答が1バイトも変わらない", async () => {
    await makeApp();
    const declared = await mcp(expert, "list_records", { table_id: "orgs" });
    expect(declared.isError, declared.text).toBe(false);
    const applied = applyManifest(dataRoot as string, APP_ID, NO_CC);
    expect(applied.valid, JSON.stringify(applied)).toBe(true);
    current = NO_CC;
    const undeclared = await mcp(expert, "list_records", { table_id: "orgs" });
    expect(declared.text).toBe(undeclared.text);
    expect(declared.text).not.toContain("create_child");
  });
});
