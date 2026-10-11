/**
 * **見本の行を作る純粋関数**(`V20-M13-T03`。計画 §9-5・§10-6 / `D-V20-44`「見本だけにする」)。
 *
 * **固定するもの**:
 *
 * 1. 9型すべての見本の形(表で書いた決まりのとおり)。
 * 2. 参照は参照先の**見本の行**を指す(依存の順。自己参照・循環・作り手の表の外は空)。
 * 3. マニフェストで宣言できる制約(型・必須・一意(`true` / `"owner"`)・選択肢・参照の実在)を満たす
 *    —— **カーネルの書き込みの検証(`createRecord`)にそのまま通す**。満たせない値は理由つきで空に
 *    なり、そのときカーネルが返す誤りは**理由に挙げた欄だけ**である。
 * 4. 同じ入力で同じ出力。
 * 5. 行の持ち主(`st_owner`)は頼んだ人 / 付与が要る表(`access_control`)は頼んだ人の名簿の行と
 *    付与の行を入れる。
 * 6. 同梱のアプリの定義の全部で例外にならず、制約を満たす。
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { applyManifestDdl } from "../kernel/ddl.ts";
import { createRecord, listRecords } from "../kernel/records.ts";
import type { Field, Manifest, Table } from "../kernel/types.ts";
import { validateManifestFull } from "../kernel/validate.ts";
import {
  isOwnerVisible,
  MAX_RECORD_ACCESS_INHERIT_DEPTH,
  resolveRecordAccess,
} from "../server/owner-scope.ts";
import { insertSamplePlan } from "./preview.ts";
import {
  buildSampleRows,
  SAMPLE_BASE_DATE,
  SAMPLE_ROWS_PER_TABLE,
  type SampleGap,
  type SamplePlan,
  sampleRowId,
} from "./sample-rows.ts";

const ROOT = join(import.meta.dir, "..", "..");
const REQUESTER = "user-requester-0001";

function manifestOf(tables: Table[], extra: Record<string, unknown> = {}): Manifest {
  return { app: { id: "sample-app", name: "見本の店", tables, views: [], ...extra } } as Manifest;
}

function tableOf(plan: SamplePlan, id: string) {
  const found = plan.tables.find((t) => t.table === id);
  if (found === undefined) throw new Error(`表 ${id} が見本に無い`);
  return found;
}

function column(plan: SamplePlan, table: string, field: string): unknown[] {
  return tableOf(plan, table).rows.map((r) => r.values[field]);
}

/** 9型を1本ずつ持つ表(+ 参照先)。 */
const ALL_TYPES: Manifest = manifestOf([
  {
    id: "items",
    name: "品",
    fields: [
      { id: "t", name: "文字", type: "text" },
      { id: "lt", name: "長文", type: "long_text" },
      { id: "n", name: "数", type: "number" },
      { id: "b", name: "真偽", type: "boolean" },
      { id: "d", name: "日付", type: "date" },
      { id: "s", name: "選択", type: "select", options: ["赤", "青", "緑"] },
      { id: "r", name: "参照", type: "reference", reference_table: "cats" },
      { id: "img", name: "画像", type: "image" },
      { id: "f", name: "添付", type: "file" },
    ],
  },
  { id: "cats", name: "分類", fields: [{ id: "name", name: "名前", type: "text" }] },
]);

// --- カーネルの検証に通す -------------------------------------------------------------

type KernelError = { table: string; row: number; path: string };

/**
 * 見本を生の SQL で入れた DB で、**1行ずつ消して `createRecord` で作り直す**(巻き戻す)。
 * 他の行は残っているので、一意と参照の実在もカーネルが判定する。
 * ワークフローは外したマニフェストで呼ぶ(検証だけを見る。自動処理を走らせない)。
 */
function kernelErrors(manifest: Manifest, plan: SamplePlan): KernelError[] {
  const db = new Database(":memory:");
  try {
    applyManifestDdl(db, manifest);
    insertSamplePlan(db, plan);
    const quiet = { app: { ...manifest.app, workflows: [], functions: [] } } as Manifest;
    const errors: KernelError[] = [];
    for (const table of plan.tables) {
      table.rows.forEach((row, index) => {
        const Rollback = new Error("rollback");
        try {
          db.transaction(() => {
            db.query(`DELETE FROM "${table.table}" WHERE "_id" = ?`).run(row._id);
            const result = createRecord(db, quiet, table.table, row.values);
            if (!result.ok) {
              for (const e of result.errors) {
                errors.push({ table: table.table, row: index + 1, path: e.path });
              }
            }
            throw Rollback;
          })();
        } catch (error) {
          if (error !== Rollback) throw error;
        }
      });
    }
    return errors;
  } finally {
    db.close();
  }
}

/** 理由つきで空にした欄のうち、必須のもの(カーネルが「必須です」と返してよい欄)。 */
function expectedRequiredErrors(manifest: Manifest, plan: SamplePlan): KernelError[] {
  const out: KernelError[] = [];
  for (const gap of plan.gaps) {
    const table = manifest.app.tables.find((t) => t.id === gap.table);
    const field = table?.fields.find((f) => f.id === gap.field);
    if (field?.required !== true) continue;
    for (const row of gap.rows) {
      out.push({ table: gap.table, row, path: `/${gap.field}` });
    }
  }
  return out;
}

function sortErrors(list: KernelError[]): string[] {
  return list.map((e) => `${e.table}#${e.row}${e.path}`).sort();
}

// --- 1. 9型の形 --------------------------------------------------------------------

describe("9型すべての見本の形", () => {
  const plan = buildSampleRows(ALL_TYPES, REQUESTER);

  test(`表ごとに ${SAMPLE_ROWS_PER_TABLE} 行(5行)`, () => {
    expect(SAMPLE_ROWS_PER_TABLE).toBe(5);
    expect(plan.tables.map((t) => [t.table, t.rows.length])).toEqual([
      ["cats", 5],
      ["items", 5],
    ]);
  });

  test("text は「見本 1」〜「見本 5」", () => {
    expect(column(plan, "items", "t")).toEqual(["見本 1", "見本 2", "見本 3", "見本 4", "見本 5"]);
  });

  test("long_text は「見本の長文 1」〜", () => {
    expect(column(plan, "items", "lt")).toEqual([
      "見本の長文 1",
      "見本の長文 2",
      "見本の長文 3",
      "見本の長文 4",
      "見本の長文 5",
    ]);
  });

  test("number は 10, 20, 30, 40, 50", () => {
    expect(column(plan, "items", "n")).toEqual([10, 20, 30, 40, 50]);
  });

  test("boolean は交互(真から)", () => {
    expect(column(plan, "items", "b")).toEqual([true, false, true, false, true]);
  });

  test("date は固定の日付(2026-01-01)から1日ずつ", () => {
    expect(SAMPLE_BASE_DATE).toBe("2026-01-01");
    expect(column(plan, "items", "d")).toEqual([
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
      "2026-01-04",
      "2026-01-05",
    ]);
  });

  test("select は並びの順に回す", () => {
    expect(column(plan, "items", "s")).toEqual(["赤", "青", "緑", "赤", "青"]);
  });

  test("reference は参照先の見本の行を順に指す", () => {
    const cats = tableOf(plan, "cats").rows.map((r) => r._id);
    expect(column(plan, "items", "r")).toEqual(cats);
  });

  test("image / file は空(写しに blobs が無い)で、理由が付く", () => {
    expect(column(plan, "items", "img")).toEqual([null, null, null, null, null]);
    expect(column(plan, "items", "f")).toEqual([null, null, null, null, null]);
    const kinds = plan.gaps
      .filter((g) => g.table === "items")
      .map((g) => [g.field, g.kind, g.rows]);
    expect(kinds).toEqual([
      ["img", "no_blobs", [1, 2, 3, 4, 5]],
      ["f", "no_blobs", [1, 2, 3, 4, 5]],
    ]);
  });

  test("行の _id は表と番号から決まり、表をまたいで重ならない", () => {
    const ids = plan.tables.flatMap((t) => t.rows.map((r) => r._id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(tableOf(plan, "items").rows[0]?._id).toBe(sampleRowId("items", 1));
  });

  test("カーネルの検証をそのまま通る(誤り0件)", () => {
    expect(kernelErrors(ALL_TYPES, plan)).toEqual([]);
  });

  test("生の SQL で入れた行をカーネルが読むと、見本の値そのものが返る(真偽の 1/0 も揃う)", () => {
    const db = new Database(":memory:");
    try {
      applyManifestDdl(db, ALL_TYPES);
      insertSamplePlan(db, plan);
      const read = listRecords(db, ALL_TYPES, "items");
      if (!read.ok) throw new Error(JSON.stringify(read.errors));
      const byId = new Map(read.value.map((r) => [r._id, r]));
      for (const row of tableOf(plan, "items").rows) {
        const got = byId.get(row._id);
        for (const [key, value] of Object.entries(row.values)) {
          expect(`${key}=${JSON.stringify(got?.[key])}`).toBe(`${key}=${JSON.stringify(value)}`);
        }
      }
    } finally {
      db.close();
    }
  });
});

// --- 2. 参照 -----------------------------------------------------------------------

describe("参照は見本の行を指す・依存の順・自己参照と循環と外は空", () => {
  test("依存の順(参照先が先)に並ぶ。マニフェストで後ろに書いた参照先も先に作る", () => {
    const m = manifestOf([
      {
        id: "order_lines",
        name: "明細",
        fields: [{ id: "order", name: "注文", type: "reference", reference_table: "orders" }],
      },
      {
        id: "orders",
        name: "注文",
        fields: [{ id: "customer", name: "客", type: "reference", reference_table: "customers" }],
      },
      { id: "customers", name: "客", fields: [{ id: "name", name: "名", type: "text" }] },
    ]);
    const plan = buildSampleRows(m, REQUESTER);
    expect(plan.tables.map((t) => t.table)).toEqual(["customers", "orders", "order_lines"]);
    expect(column(plan, "orders", "customer")).toEqual(
      tableOf(plan, "customers").rows.map((r) => r._id),
    );
    expect(kernelErrors(m, plan)).toEqual([]);
  });

  test("自己参照は空(理由 self_reference)", () => {
    const m = manifestOf([
      {
        id: "staff",
        name: "職員",
        fields: [
          { id: "name", name: "名", type: "text" },
          { id: "boss", name: "上司", type: "reference", reference_table: "staff" },
        ],
      },
    ]);
    const plan = buildSampleRows(m, REQUESTER);
    expect(column(plan, "staff", "boss")).toEqual([null, null, null, null, null]);
    expect(plan.gaps.map((g) => [g.table, g.field, g.kind])).toEqual([
      ["staff", "boss", "self_reference"],
    ]);
    expect(kernelErrors(m, plan)).toEqual([]);
  });

  test("循環は1本だけ切って空にし(理由 cycle)、残りは見本の行を指す", () => {
    const m = manifestOf([
      {
        id: "a",
        name: "A",
        fields: [{ id: "to_b", name: "B", type: "reference", reference_table: "b" }],
      },
      {
        id: "b",
        name: "B",
        fields: [{ id: "to_a", name: "A", type: "reference", reference_table: "a" }],
      },
    ]);
    const plan = buildSampleRows(m, REQUESTER);
    expect(plan.gaps.map((g) => [g.table, g.field, g.kind])).toEqual([["b", "to_a", "cycle"]]);
    expect(column(plan, "b", "to_a")).toEqual([null, null, null, null, null]);
    expect(column(plan, "a", "to_b")).toEqual(tableOf(plan, "b").rows.map((r) => r._id));
    expect(plan.tables.map((t) => t.table)).toEqual(["b", "a"]);
    expect(kernelErrors(m, plan)).toEqual([]);
  });

  test("必須の自己参照は空になり、カーネルが返す誤りは理由に挙げた欄だけ", () => {
    const m = manifestOf([
      {
        id: "node",
        name: "節",
        fields: [
          { id: "parent", name: "親", type: "reference", reference_table: "node", required: true },
        ],
      },
    ]);
    const plan = buildSampleRows(m, REQUESTER);
    const gap = plan.gaps[0] as SampleGap;
    expect([gap.kind, gap.required]).toEqual(["self_reference", true]);
    expect(sortErrors(kernelErrors(m, plan))).toEqual(sortErrors(expectedRequiredErrors(m, plan)));
    expect(kernelErrors(m, plan)).toHaveLength(5);
  });
});

// --- 3. 制約 -----------------------------------------------------------------------

describe("制約を満たす(必須・一意・選択肢)", () => {
  test("必須と一意(true / owner)の文字・数・日付・参照は5行とも別の値で埋まる", () => {
    const m = manifestOf([
      { id: "cats", name: "分類", fields: [{ id: "name", name: "名", type: "text" }] },
      {
        id: "things",
        name: "物",
        fields: [
          { id: "code", name: "コード", type: "text", required: true, unique: true },
          { id: "memo", name: "メモ", type: "long_text", required: true, unique: "owner" },
          { id: "no", name: "番号", type: "number", required: true, unique: true },
          { id: "on", name: "日", type: "date", required: true, unique: true },
          {
            id: "cat",
            name: "分類",
            type: "reference",
            reference_table: "cats",
            required: true,
            unique: true,
          },
          { id: "st_owner", name: "持ち主", type: "text" },
        ],
      },
    ]);
    const plan = buildSampleRows(m, REQUESTER);
    expect(plan.gaps).toEqual([]);
    for (const f of ["code", "memo", "no", "on", "cat"]) {
      const values = column(plan, "things", f);
      expect(new Set(values).size).toBe(5);
      expect(values.includes(null)).toBe(false);
    }
    expect(kernelErrors(m, plan)).toEqual([]);
  });

  test("一意の真偽は2行までしか埋まらず、残りは空(理由 unique_exhausted)。必須でなければカーネルは通す", () => {
    const m = manifestOf([
      {
        id: "flags",
        name: "旗",
        fields: [{ id: "on", name: "オン", type: "boolean", unique: true }],
      },
    ]);
    const plan = buildSampleRows(m, REQUESTER);
    expect(column(plan, "flags", "on")).toEqual([true, false, null, null, null]);
    expect(plan.gaps.map((g) => [g.field, g.kind, g.rows, g.required])).toEqual([
      ["on", "unique_exhausted", [3, 4, 5], false],
    ]);
    expect(kernelErrors(m, plan)).toEqual([]);
  });

  test("一意の選択肢は選択肢の数までしか埋まらない。必須なら、カーネルの誤りは理由に挙げた行だけ", () => {
    const m = manifestOf([
      {
        id: "slots",
        name: "枠",
        fields: [
          {
            id: "size",
            name: "大きさ",
            type: "select",
            options: ["S", "M"],
            unique: true,
            required: true,
          },
        ],
      },
    ]);
    const plan = buildSampleRows(m, REQUESTER);
    expect(column(plan, "slots", "size")).toEqual(["S", "M", null, null, null]);
    const errors = kernelErrors(m, plan);
    expect(sortErrors(errors)).toEqual(sortErrors(expectedRequiredErrors(m, plan)));
    expect(errors).toHaveLength(3);
  });

  test("必須の画像・添付は空になり(理由 no_blobs・required)、カーネルの誤りはその欄だけ", () => {
    const m = manifestOf([
      {
        id: "docs",
        name: "書類",
        fields: [
          { id: "title", name: "題", type: "text", required: true },
          { id: "scan", name: "写し", type: "file", required: true },
        ],
      },
    ]);
    const plan = buildSampleRows(m, REQUESTER);
    expect(plan.gaps.map((g) => [g.field, g.kind, g.required])).toEqual([
      ["scan", "no_blobs", true],
    ]);
    const errors = kernelErrors(m, plan);
    expect(sortErrors(errors)).toEqual(sortErrors(expectedRequiredErrors(m, plan)));
    expect(errors).toHaveLength(5);
  });

  test("マニフェストの項目に値域・最小最大・パターンを書くキーは無い(開けた制約の全量)", () => {
    const schema = JSON.parse(
      readFileSync(join(ROOT, "schemas", "manifest.schema.json"), "utf8"),
    ) as { $defs: { field: { properties: Record<string, unknown> } } };
    expect(Object.keys(schema.$defs.field.properties).sort()).toEqual(
      [
        "emphasis",
        "hide_when_empty",
        "id",
        "name",
        "options",
        "reference_picker",
        "reference_search_fields",
        "reference_table",
        "required",
        "type",
        "unique",
        // 【`V23-M2-T02` / `ADR-0498` 限定1 / 授権 `ADR-0517` 行14】13本目。一意違反の文言であって、
        // 値域・最小最大・パターンを書くキーではない(主題は動いていない)。
        "unique_message",
        "unit",
      ].sort(),
    );
  });
});

// --- 4. 決定性 ---------------------------------------------------------------------

describe("同じ入力で同じ出力", () => {
  test("2回呼んで toEqual・入力のマニフェストを書き換えない", () => {
    const before = JSON.stringify(ALL_TYPES);
    const a = buildSampleRows(ALL_TYPES, REQUESTER);
    const b = buildSampleRows(ALL_TYPES, REQUESTER);
    expect(a).toEqual(b);
    expect(JSON.stringify(ALL_TYPES)).toBe(before);
  });

  test("頼んだ人が違えば持ち主だけが違う", () => {
    const m = manifestOf([
      {
        id: "memo",
        name: "メモ",
        fields: [
          { id: "body", name: "本文", type: "text" },
          { id: "st_owner", name: "持ち主", type: "text" },
        ],
      },
    ]);
    const a = buildSampleRows(m, "u-a");
    const b = buildSampleRows(m, "u-b");
    expect(column(a, "memo", "st_owner")).toEqual(["u-a", "u-a", "u-a", "u-a", "u-a"]);
    expect(column(b, "memo", "st_owner")).toEqual(["u-b", "u-b", "u-b", "u-b", "u-b"]);
    expect(column(a, "memo", "body")).toEqual(column(b, "memo", "body"));
  });
});

// --- 5. 持ち主と付与 ---------------------------------------------------------------

function accessControlled(overrides: Record<string, unknown> = {}): Manifest {
  return manifestOf([
    {
      id: "project",
      name: "案件",
      fields: [{ id: "title", name: "件名", type: "text", required: true }],
      access_control: {
        enabled: true,
        permissions: [
          { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
          { id: "writer", name: "編集可", read: true, write: true, delete: false },
        ],
        creator_permission: "writer",
        grant: {
          table: "project_grant",
          target: "target",
          member: "member",
          permission: "permission",
        },
        members: { table: "member", account: "account" },
        ...overrides,
      },
    } as Table,
    {
      id: "project_grant",
      name: "案件の付与",
      fields: [
        { id: "target", name: "案件", type: "reference", reference_table: "project" },
        { id: "member", name: "利用者", type: "reference", reference_table: "member" },
        { id: "permission", name: "権限", type: "select", options: ["reader", "writer"] },
      ],
    },
    {
      id: "member",
      name: "利用者",
      fields: [{ id: "account", name: "ログイン", type: "text" }],
    },
  ]);
}

describe("行の持ち主と付与", () => {
  test("基準形のマニフェストはカーネルの定義の検証を通る(以下の測定の前提)", () => {
    const result = validateManifestFull(accessControlled());
    expect(result.valid, JSON.stringify(result)).toBe(true);
  });

  test("付与の要る表: 名簿の1行目が頼んだ人・付与の行が見本の5行を1本ずつ頼んだ人に作成者の権限で渡す", () => {
    const m = accessControlled();
    const plan = buildSampleRows(m, REQUESTER);
    const member = tableOf(plan, "member").rows;
    expect(member[0]?.values.account).toBe(REQUESTER);
    const grants = tableOf(plan, "project_grant").rows;
    expect(grants).toHaveLength(5);
    expect(grants.map((g) => g.values.target)).toEqual(
      tableOf(plan, "project").rows.map((r) => r._id),
    );
    expect(grants.map((g) => g.values.member)).toEqual(Array(5).fill(member[0]?._id));
    expect(grants.map((g) => g.values.permission)).toEqual(Array(5).fill("writer"));
    expect(plan.gaps).toEqual([]);
    expect(kernelErrors(m, plan)).toEqual([]);
  });

  test("1つの付与の表を2つの表が使うと、付与の行は表ごとに5行(計10行)で、他の表の対象は空", () => {
    const base = accessControlled();
    const tables = base.app.tables.map((t) => structuredClone(t));
    const project = tables[0] as Table;
    const task: Table = {
      ...structuredClone(project),
      id: "task",
      name: "作業",
      access_control: {
        ...(project.access_control as NonNullable<Table["access_control"]>),
        grant: {
          table: "project_grant",
          target: "task_target",
          member: "member",
          permission: "permission",
        },
      },
    };
    const grant = tables[1] as Table;
    grant.fields.push({
      id: "task_target",
      name: "作業",
      type: "reference",
      reference_table: "task",
    } as Field);
    const m = manifestOf([project, task, grant, tables[2] as Table]);
    expect(validateManifestFull(m).valid).toBe(true);
    const plan = buildSampleRows(m, REQUESTER);
    const grants = tableOf(plan, "project_grant").rows;
    expect(grants).toHaveLength(10);
    const projectIds = tableOf(plan, "project").rows.map((r) => r._id);
    const taskIds = tableOf(plan, "task").rows.map((r) => r._id);
    expect(grants.slice(0, 5).map((g) => [g.values.target, g.values.task_target])).toEqual(
      projectIds.map((id) => [id, null]),
    );
    expect(grants.slice(5).map((g) => [g.values.target, g.values.task_target])).toEqual(
      taskIds.map((id) => [null, id]),
    );
    expect(kernelErrors(m, plan)).toEqual([]);
  });

  test("穴: 作成者の権限が付与の表の選択肢に無いと、付与の権限は空になる(理由 grant_permission_not_option)", () => {
    const m = accessControlled();
    const grant = m.app.tables[1] as Table;
    (grant.fields[2] as { options: string[] }).options = ["reader"];
    const plan = buildSampleRows(m, REQUESTER);
    expect(column(plan, "project_grant", "permission")).toEqual(Array(5).fill(null));
    expect(plan.gaps.map((g) => [g.table, g.field, g.kind])).toEqual([
      ["project_grant", "permission", "grant_permission_not_option"],
    ]);
  });

  test("穴: 付与の相手の欄が一意だと、2行目以降の付与は相手が空になる(理由 unique_exhausted)", () => {
    const m = accessControlled();
    const grant = m.app.tables[1] as Table;
    (grant.fields[1] as { unique?: boolean }).unique = true;
    const plan = buildSampleRows(m, REQUESTER);
    expect(column(plan, "project_grant", "member").slice(1)).toEqual(Array(4).fill(null));
    expect(plan.gaps.map((g) => [g.table, g.field, g.kind, g.rows])).toEqual([
      ["project_grant", "member", "unique_exhausted", [2, 3, 4, 5]],
    ]);
    expect(kernelErrors(m, plan)).toEqual([]);
  });

  test("グループだけで渡す形は今日のカーネルが定義ごと断る。関数に直に渡すと付与の相手は空(理由 grant_unreachable)", () => {
    const m = accessControlled({
      grant: { table: "project_grant", target: "target", group: "grp", permission: "permission" },
      members: { table: "member", account: "account", group: "team" },
      groups: { table: "team_table" },
    });
    const grant = m.app.tables[1] as Table;
    grant.fields = grant.fields.filter((f) => f.id !== "member");
    grant.fields.push({ id: "grp", name: "組", type: "reference", reference_table: "team_table" });
    (m.app.tables[2] as Table).fields.push({
      id: "team",
      name: "組",
      type: "reference",
      reference_table: "team_table",
    });
    m.app.tables.push({
      id: "team_table",
      name: "組",
      fields: [{ id: "name", name: "名", type: "text" }],
    });
    const validated = validateManifestFull(m);
    expect(validated.valid).toBe(false);
    expect(JSON.stringify(validated)).toContain("grant/member");
    const plan = buildSampleRows(m, REQUESTER);
    expect(tableOf(plan, "member").rows[0]?.values.account).toBe(REQUESTER);
    expect(plan.gaps.map((g) => [g.table, g.field, g.kind, g.rows])).toEqual([
      ["project_grant", "grp", "grant_unreachable", [1, 2, 3, 4, 5]],
    ]);
    expect(column(plan, "project_grant", "grp")).toEqual(Array(5).fill(null));
  });

  test("enabled: false の表には付与の行を足さない(付与の表は他の表と同じく見本5行)", () => {
    const m = accessControlled({ enabled: false });
    const plan = buildSampleRows(m, REQUESTER);
    expect(tableOf(plan, "member").rows[0]?.values.account).toBe("見本 1");
    expect(tableOf(plan, "project_grant").rows).toHaveLength(5);
    expect(column(plan, "project_grant", "permission")).toEqual([
      "reader",
      "writer",
      "reader",
      "writer",
      "reader",
    ]);
  });
});

// --- 5b. 見えるかをサーバの判定で確かめる ------------------------------------------

/** 見本の行を行の形(`_id` + 欄)に直して、サーバの行の判定に渡す読み手を作る。 */
function readersOf(plan: SamplePlan) {
  const rowsOf = (tableId: string): Record<string, unknown>[] =>
    (plan.tables.find((t) => t.table === tableId)?.rows ?? []).map((r) => ({
      _id: r._id,
      ...r.values,
    }));
  return {
    rowsOf,
    readRows: (tableId: string) => rowsOf(tableId),
    readRow: (tableId: string, recordId: string) => rowsOf(tableId).find((r) => r._id === recordId),
  };
}

/** 付与の要る表・持ち主の表の見本の行のうち、actor が読める行の数(表ごと)。 */
function readableCounts(manifest: Manifest, plan: SamplePlan, actorId: string): string[] {
  const { rowsOf, readRows, readRow } = readersOf(plan);
  const out: string[] = [];
  for (const table of manifest.app.tables) {
    const governed = table.access_control?.enabled === true;
    const owned = table.fields.some((f) => f.id === "st_owner" && f.type === "text");
    if (!governed && !owned) continue;
    const rows = rowsOf(table.id);
    const readable = rows.filter((row) => {
      if (owned && !isOwnerVisible(row.st_owner, actorId)) return false;
      if (!governed) return true;
      const resolution = resolveRecordAccess({
        manifest,
        tableId: table.id,
        row,
        actorId,
        readRows,
        readRow,
      });
      return resolution.kind === "verdict" && resolution.verdict.read;
    });
    out.push(`${table.id}:${readable.length}/${rows.length}`);
  }
  return out;
}

/**
 * 付与の表 `dep_grant` を `levels` 本の表(`lvl0` → `lvl1` → … と親を引き継ぐ)が共有する定義 +
 * 持ち主の表 `own_memo`。**生成器の突き合わせ用の定義と同じ形をこの場で組む**
 * (`apps/smailtalk` は単独で成り立つ公開単位なので、隣の単位のファイルを読まない)。
 */
function chainManifest(levels: number): Manifest {
  const permissions = [
    { id: "reader", name: "読める", read: true, write: false, delete: false },
    { id: "writer", name: "書ける", read: true, write: true, delete: false },
    { id: "keeper", name: "作った人", read: true, write: true, delete: true },
  ];
  const tables: Table[] = [
    {
      id: "own_memo",
      name: "自分のメモ",
      fields: [
        { id: "title", name: "件名", type: "text", required: true },
        { id: "st_owner", name: "持ち主", type: "text" },
      ],
    },
  ];
  for (let i = 0; i < levels; i += 1) {
    const root = i === levels - 1;
    const fields: Field[] = [{ id: "title", name: "件名", type: "text", required: true }];
    if (!root) {
      fields.push({ id: "parent", name: "親", type: "reference", reference_table: `lvl${i + 1}` });
    }
    tables.push({
      id: `lvl${i}`,
      name: `段${i}`,
      fields,
      access_control: {
        enabled: true,
        permissions,
        creator_permission: "keeper",
        grant: { table: "dep_grant", target: `t${i}`, member: "member", permission: "permission" },
        members: { table: "dep_member", account: "account" },
        ...(root ? {} : { inherit_from: ["parent"] }),
      },
    } as Table);
  }
  tables.push({
    id: "dep_grant",
    name: "付与",
    fields: [
      ...Array.from(
        { length: levels },
        (_, i): Field => ({
          id: `t${i}`,
          name: `段${i}`,
          type: "reference",
          reference_table: `lvl${i}`,
        }),
      ),
      { id: "member", name: "相手", type: "reference", reference_table: "dep_member" },
      { id: "permission", name: "権限", type: "select", options: ["reader", "writer", "keeper"] },
    ],
  });
  tables.push({
    id: "dep_member",
    name: "利用者",
    fields: [{ id: "account", name: "ログイン名", type: "text" }],
  });
  return manifestOf(tables);
}

describe("頼んだ人に見える(サーバの行の判定 resolveRecordAccess / isOwnerVisible に通す)", () => {
  test("付与の要る表の見本5行は、頼んだ人には全部読め、他の人には1行も読めない(陰性対照)", () => {
    const m = accessControlled();
    const plan = buildSampleRows(m, REQUESTER);
    expect(readableCounts(m, plan, REQUESTER)).toEqual(["project:5/5"]);
    expect(readableCounts(m, plan, "someone-else")).toEqual(["project:0/5"]);
  });

  test("付与の表を7つの表が共有し、引き継ぎが6段つながる定義でも頼んだ人に読める。穴: 引き継ぎが上限の段数を越える lvl0 だけは判定が出ず読めない", () => {
    const m = chainManifest(7);
    expect(validateManifestFull(m).valid, JSON.stringify(validateManifestFull(m))).toBe(true);
    expect(MAX_RECORD_ACCESS_INHERIT_DEPTH).toBe(5);
    const plan = buildSampleRows(m, REQUESTER);
    expect(tableOf(plan, "dep_grant").rows).toHaveLength(35);
    expect(readableCounts(m, plan, REQUESTER)).toEqual([
      "own_memo:5/5",
      "lvl0:0/5",
      "lvl1:5/5",
      "lvl2:5/5",
      "lvl3:5/5",
      "lvl4:5/5",
      "lvl5:5/5",
      "lvl6:5/5",
    ]);
    // lvl0 が読めないのは見本の作り方ではなく、定義が引き継ぎの段数の上限(5)を越えるため
    // (本物の行でも同じ答えになる)。
    const { rowsOf, readRows, readRow } = readersOf(plan);
    const resolution = resolveRecordAccess({
      manifest: m,
      tableId: "lvl0",
      row: rowsOf("lvl0")[0] as Record<string, unknown>,
      actorId: REQUESTER,
      readRows,
      readRow,
    });
    expect(resolution).toEqual({ kind: "limit_exceeded", limit: "depth" });
    for (const entry of readableCounts(m, plan, "someone-else")) {
      expect(entry).toMatch(/:0\/5$/);
    }
    expect(kernelErrors(m, plan)).toEqual([]);
  });

  test("引き継ぎが上限の段数に収まる定義(6表)では、全部の表が頼んだ人に読める(上の穴の対照)", () => {
    const m = chainManifest(6);
    const plan = buildSampleRows(m, REQUESTER);
    for (const entry of readableCounts(m, plan, REQUESTER)) {
      expect(entry).toMatch(/:5\/5$/);
    }
  });
});

// --- 6. 同梱のアプリの定義 --------------------------------------------------------

/** 同梱のアプリの定義(差分ではなくマニフェストのもの)。 */
function bundledManifests(): { file: string; manifest: Manifest }[] {
  const out: { file: string; manifest: Manifest }[] = [];
  const validDir = join(ROOT, "fixtures", "valid");
  for (const name of readdirSync(validDir).sort()) {
    if (!name.endsWith(".json")) continue;
    const parsed = JSON.parse(readFileSync(join(validDir, name), "utf8")) as Record<
      string,
      unknown
    >;
    if (parsed.app === undefined) continue; // 差分(diff_id / operations)はアプリの定義ではない
    out.push({ file: `fixtures/valid/${name}`, manifest: parsed as Manifest });
  }
  return out;
}

describe("同梱のアプリの定義の全部に当てる", () => {
  const all = bundledManifests();

  test("本数(fixtures/valid のマニフェスト10本。差分2本は外す)", () => {
    expect(all.map((a) => a.file)).toHaveLength(10);
  });

  for (const { file, manifest } of all) {
    test(`${file}: 例外にならず、表ごとに5行以上、カーネルの誤りは理由に挙げた必須の欄だけ`, () => {
      expect(validateManifestFull(manifest).valid).toBe(true);
      const plan = buildSampleRows(manifest, REQUESTER);
      expect(plan.tables.map((t) => t.table).sort()).toEqual(
        manifest.app.tables.map((t) => t.id).sort(),
      );
      for (const t of plan.tables) {
        expect(t.rows.length % SAMPLE_ROWS_PER_TABLE).toBe(0);
        expect(t.rows.length).toBeGreaterThanOrEqual(SAMPLE_ROWS_PER_TABLE);
      }
      expect(sortErrors(kernelErrors(manifest, plan))).toEqual(
        sortErrors(expectedRequiredErrors(manifest, plan)),
      );
    });
  }
});
