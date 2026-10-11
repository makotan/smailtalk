/**
 * **行を相手にした付与の読取の解決 —— 判定の家の純粋な関数で撃つ**
 * (`V23-M6-T03`。門A = `ADR-0502`(`SC-G20`)を補う `ADR-0538` §Decision 1-2・1-3。
 * 決定 `D-V23-150`・`D-V23-151`・`D-V23-161`・`D-V23-165`。授権 `ADR-0539`)。
 *
 * ## この検査が測るもの / 測らないもの(**先に書く**)
 *
 * **測るもの**(行は DB でなく手元の表で持ち、読む手は「1つの要求」の形で毎回作り直す):
 * 1. **使う側**: 守る表 R の行を、行 S を相手にした付与で読める(S に `via` を持つ人。直接とグループ経由)/
 *    S から外すと次の要求ですぐ読めない / `via` に無い権限の人は読めない / R の `restrictive` が効く /
 *    R の子の表(`inherit_from`)に届く / 出どころに「行経由」の印 / `creatable_by` の照合で S 経由を数える /
 *    親の読取の検査(付与の書込)で相手の人ごとに読み替える / 付与の書込の 404 と 403 の読み分け。
 * 2. **閉じる側**: S の親は辿らない / S 側の `principal_row` は辿らない / S の行が消えたら効かない /
 *    S の表の宣言が壊れていたら効かない。
 * 3. **使わない側**: 付与の書込の「作成者か」そのもの / 最後の管理者 / 招待の発行権と管理権 /
 *    作成者付与の下見(源の形)。 付与表・名簿の見える範囲は実 HTTP の検査(`principal-row-entries.test.ts`)で見る。
 * 4. **数え方**: 引き継ぎの行数の数えに S 側の読みを入れない / `principal_row` の無いアプリで S 側の表を1本も読まない /
 *    S 側の解決は1つの要求の中で S の1行につき1回。
 *
 * **測らないもの(誇張しない)**: 入口ごとの配線(`principal-row-entries.test.ts`)。 付与の書込の断り(`T04`)。
 * コードとコードの招待(`T05`・`T06`)。 相手の名前の見せ方(`T04b`)。 生成器(`T09`)。
 */

import { describe, expect, test } from "bun:test";
import type { Manifest } from "../kernel/types.ts";
import {
  judgeCreateParentAccess,
  judgeGrantWrite,
  lastRowAdminVanishes,
  recordAccessSourceTables,
  resolveRecordAccess,
  resolveRecordAccessSources,
  rowInvitationAccess,
} from "./owner-scope.ts";

type Row = Record<string, unknown>;
type Store = Map<string, Row[]>;

const ref = (id: string, table: string): Row => ({
  id,
  name: id,
  type: "reference",
  reference_table: table,
});

/**
 * 題材: 名簿1本(`members`)を3つの表が共有する。
 * - `units`(S。相手の行の表): 権限 `unit_lead`(作成者)・`unit_member`・`unit_guest`。 親 `networks` から引き継ぐ。
 * - `projects`(R。守る表): 権限 `p_admin`(作成者)・`p_worker`・`p_audit`(上限つきの読むだけ)。
 *   付与表 `project_grants` の `unit` 列が S を指す(`principal_row`。`via` は `unit_member`・`unit_lead`)。
 * - `tasks`(R の子): `project` から引き継ぐ。 子を作れるのは親に `p_worker` を持つ人。
 */
function manifest(options: { principalRow?: boolean; taskVia?: readonly string[] } = {}): Manifest {
  const principal = options.principalRow !== false;
  // **【独立点検の処置】`taskVia` を渡すと、子の表 `tasks` にも同じ S を指す `principal_row` を置く**
  // (`via` は渡した名前。案件と違う `via` で、同じ S を2つの守る表が指す形)。 渡さなければ着手前と同じ定義。
  const taskVia = options.taskVia;
  return {
    app: {
      id: "pr-unit",
      name: "行を相手にした付与",
      tables: [
        {
          id: "members",
          name: "名簿",
          fields: [
            { id: "name", name: "名前", type: "text" },
            { id: "account", name: "利用者", type: "text" },
            ref("grp", "groups"),
          ],
        },
        { id: "groups", name: "グループ", fields: [{ id: "title", name: "名前", type: "text" }] },
        {
          id: "networks",
          name: "連合",
          fields: [{ id: "title", name: "名前", type: "text" }],
          access_control: {
            enabled: true,
            permissions: [{ id: "net_admin", name: "管理", read: true, write: true, delete: true }],
            creator_permission: "net_admin",
            grant: {
              table: "network_grants",
              target: "network",
              member: "member",
              permission: "permission",
            },
            members: { table: "members", account: "account" },
          },
        },
        {
          id: "network_grants",
          name: "連合の付与",
          fields: [
            ref("network", "networks"),
            ref("member", "members"),
            { id: "permission", name: "権限", type: "text" },
          ],
        },
        {
          id: "units",
          name: "部隊",
          representative_field: "title",
          fields: [{ id: "title", name: "名前", type: "text" }, ref("network", "networks")],
          access_control: {
            enabled: true,
            permissions: [
              { id: "unit_lead", name: "長", read: true, write: true, delete: true },
              { id: "unit_member", name: "所属", read: true, write: false, delete: false },
              { id: "unit_guest", name: "客", read: true, write: false, delete: false },
            ],
            creator_permission: "unit_lead",
            grant: {
              table: "unit_grants",
              target: "unit",
              member: "member",
              group: "group",
              permission: "permission",
            },
            members: { table: "members", account: "account", group: "grp" },
            groups: { table: "groups" },
            inherit_from: ["network"],
          },
        },
        {
          id: "unit_grants",
          name: "部隊の付与",
          fields: [
            ref("unit", "units"),
            ref("member", "members"),
            ref("group", "groups"),
            { id: "permission", name: "権限", type: "text" },
          ],
        },
        {
          id: "projects",
          name: "案件",
          representative_field: "title",
          fields: [{ id: "title", name: "名前", type: "text" }],
          access_control: {
            enabled: true,
            permissions: [
              { id: "p_admin", name: "管理", read: true, write: true, delete: true },
              { id: "p_worker", name: "担当", read: true, write: true, delete: true },
              {
                id: "p_audit",
                name: "監査",
                read: true,
                write: false,
                delete: false,
                restrictive: true,
              },
            ],
            creator_permission: "p_admin",
            grant: {
              table: "project_grants",
              target: "project",
              member: "member",
              permission: "permission",
              ...(principal
                ? {
                    principal_row: {
                      column: "unit",
                      table: "units",
                      via: ["unit_member", "unit_lead"],
                    },
                  }
                : {}),
            },
            members: { table: "members", account: "account" },
            invitations: { by: ["p_admin"], grantable: ["p_worker"] },
          },
        },
        {
          id: "project_grants",
          name: "案件の付与",
          fields: [
            ref("project", "projects"),
            ref("member", "members"),
            ref("unit", "units"),
            { id: "permission", name: "権限", type: "text" },
          ],
        },
        {
          id: "tasks",
          name: "作業",
          fields: [{ id: "title", name: "名前", type: "text" }, ref("project", "projects")],
          access_control: {
            enabled: true,
            permissions: [
              { id: "t_admin", name: "管理", read: true, write: true, delete: true },
              { id: "p_worker", name: "担当", read: true, write: true, delete: false },
            ],
            creator_permission: "t_admin",
            grant: {
              table: "task_grants",
              target: "task",
              member: "member",
              permission: "permission",
              ...(taskVia === undefined
                ? {}
                : { principal_row: { column: "unit", table: "units", via: [...taskVia] } }),
            },
            members: { table: "members", account: "account" },
            inherit_from: ["project"],
            creatable_by: ["p_worker"],
          },
        },
        {
          id: "task_grants",
          name: "作業の付与",
          fields: [
            ref("task", "tasks"),
            ref("member", "members"),
            ...(taskVia === undefined ? [] : [ref("unit", "units")]),
            { id: "permission", name: "権限", type: "text" },
          ],
        },
      ],
      views: [],
    },
  } as unknown as Manifest;
}

/**
 * 行の台。 利用者は `u-admin`(P1 の管理)・`u-expert`(A1 に `unit_member`)・`u-guest`(A1 に `unit_guest`)・
 * `u-team`(A1 にグループ経由の `unit_member`)・`u-net`(A1 の親 N1 の管理)・`u-out`(名簿だけ)。
 * P1 に付与は2つ: `u-admin` へ `p_admin` と、行 A1 へ `p_worker`。
 */
function store(): Store {
  const s: Store = new Map();
  s.set("groups", [{ _id: "g1", title: "班" }]);
  s.set("members", [
    { _id: "m-admin", name: "管理者", account: "u-admin" },
    { _id: "m-expert", name: "専門家", account: "u-expert" },
    { _id: "m-guest", name: "客", account: "u-guest" },
    { _id: "m-team", name: "班の人", account: "u-team", grp: "g1" },
    { _id: "m-net", name: "連合の人", account: "u-net" },
    { _id: "m-out", name: "外の人", account: "u-out" },
  ]);
  s.set("networks", [{ _id: "N1", title: "連合1" }]);
  s.set("network_grants", [
    { _id: "ng1", network: "N1", member: "m-net", permission: "net_admin" },
  ]);
  s.set("units", [
    { _id: "A1", title: "部隊1", network: "N1" },
    { _id: "A2", title: "部隊2" },
  ]);
  s.set("unit_grants", [
    { _id: "ug1", unit: "A1", member: "m-expert", permission: "unit_member" },
    { _id: "ug2", unit: "A1", member: "m-guest", permission: "unit_guest" },
    { _id: "ug3", unit: "A1", group: "g1", permission: "unit_member" },
  ]);
  s.set("projects", [
    { _id: "P1", title: "案件1" },
    { _id: "P2", title: "案件2" },
  ]);
  s.set("project_grants", [
    { _id: "pg1", project: "P1", member: "m-admin", permission: "p_admin" },
    { _id: "pg2", project: "P1", unit: "A1", permission: "p_worker" },
  ]);
  s.set("tasks", [{ _id: "T1", title: "作業1", project: "P1" }]);
  s.set("task_grants", [{ _id: "tg1", task: "T1", member: "m-admin", permission: "t_admin" }]);
  return s;
}

/** 1つの要求の読む手(要求ごとに作り直す)。 表ごとの読みの回数を数える。 */
function readers(s: Store) {
  const counts = new Map<string, number>();
  const readRows = (tableId: string): readonly Row[] => {
    counts.set(tableId, (counts.get(tableId) ?? 0) + 1);
    return s.get(tableId) ?? [];
  };
  const readRow = (tableId: string, recordId: string): Row | undefined =>
    (s.get(tableId) ?? []).find((row) => row._id === recordId);
  return { readRows, readRow, counts };
}

function access(s: Store, tableId: string, recordId: string, actor: string, m = manifest()) {
  const { readRows, readRow } = readers(s);
  const row = readRow(tableId, recordId);
  if (row === undefined) {
    throw new Error(`${tableId} ${recordId} が無い`);
  }
  const resolved = resolveRecordAccess({
    manifest: m,
    tableId,
    row,
    actorId: actor,
    readRows,
    readRow,
  });
  if (resolved.kind !== "verdict") {
    throw new Error(`上限に当たった: ${resolved.limit}`);
  }
  return resolved.verdict;
}

const NONE = { read: false, write: false, delete: false };
const ALL = { read: true, write: true, delete: true };

describe("(U) 使う側: 行 S を相手にした付与で R を読める", () => {
  test("(U-1) S に via(unit_member)を直接持つ人は、R の行を付与の権限どおりに読み書きできる", () => {
    expect(access(store(), "projects", "P1", "u-expert")).toEqual(ALL);
    // 陰性対照: 付与の無い案件 P2 は今日どおり読めない。
    expect(access(store(), "projects", "P2", "u-expert")).toEqual(NONE);
  });

  test("(U-2) S にグループ経由で via を持つ人も読める", () => {
    expect(access(store(), "projects", "P1", "u-team")).toEqual(ALL);
  });

  test("(U-3) S から外す(S の付与の行を消す)と、次の要求ですぐ読めない", () => {
    const s = store();
    expect(access(s, "projects", "P1", "u-expert").read).toBe(true);
    s.set(
      "unit_grants",
      (s.get("unit_grants") ?? []).filter((row) => row._id !== "ug1"),
    );
    expect(access(s, "projects", "P1", "u-expert")).toEqual(NONE);
  });

  test("(U-4) S に via に無い権限(unit_guest)だけを持つ人は読めない", () => {
    expect(access(store(), "projects", "P1", "u-guest")).toEqual(NONE);
    // S 自体は読める(S 側の付与は効いている)ことを並べて見る。
    expect(access(store(), "units", "A1", "u-guest").read).toBe(true);
  });

  test("(U-5) R の restrictive は読み替えた付与にも効く(上限つきの権限を S 経由で持つと書けない)", () => {
    const s = store();
    s.set("project_grants", [
      ...(s.get("project_grants") ?? []),
      { _id: "pg3", project: "P1", unit: "A1", permission: "p_audit" },
    ]);
    expect(access(s, "projects", "P1", "u-expert")).toEqual({
      read: true,
      write: false,
      delete: false,
    });
  });

  test("(U-6) R の子の表(inherit_from)に届く", () => {
    expect(access(store(), "tasks", "T1", "u-expert")).toEqual(ALL);
    expect(access(store(), "tasks", "T1", "u-out")).toEqual(NONE);
  });

  test("(U-7) 出どころ: S 経由の付与には「行経由」の印(経由した S の行)が付き、直接の付与には付かない", () => {
    const s = store();
    const { readRows, readRow } = readers(s);
    const resolved = resolveRecordAccessSources({
      manifest: manifest(),
      tableId: "projects",
      row: readRow("projects", "P1") as Row,
      actorId: "u-expert",
      roles: ["staff"],
      member: null,
      sources: recordAccessSourceTables(manifest(), "projects"),
      readRows,
      readRow,
    });
    expect(resolved.kind).toBe("verdict");
    if (resolved.kind !== "verdict") {
      return;
    }
    expect(resolved.subject).toEqual(ALL);
    expect(resolved.sources).toHaveLength(1);
    expect(resolved.sources[0]).toMatchObject({
      table: "project_grants",
      record_id: "pg2",
      permission: "p_worker",
      via: "self",
      principal: { table: "units", record_id: "A1" },
    });
    // 直接の付与(管理者)には印が付かない。
    const { readRows: r2, readRow: g2 } = readers(s);
    const admin = resolveRecordAccessSources({
      manifest: manifest(),
      tableId: "projects",
      row: g2("projects", "P1") as Row,
      actorId: "u-admin",
      roles: ["staff"],
      member: null,
      sources: recordAccessSourceTables(manifest(), "projects"),
      readRows: r2,
      readRow: g2,
    });
    expect(
      admin.kind === "verdict" ? admin.sources.map((entry) => Object.keys(entry).sort()) : [],
    ).toEqual([["depth", "grants", "permission", "record_id", "table", "through", "via"]]);
  });

  test("(U-8) 作成の親の関門: creatable_by の名前の照合で S 経由の名前を数える", () => {
    const s = store();
    const { readRows, readRow } = readers(s);
    expect(
      judgeCreateParentAccess({
        manifest: manifest(),
        tableId: "tasks",
        values: { title: "新しい作業", project: "P1" },
        actorId: "u-expert",
        readRows,
        readRow,
      }),
    ).toEqual({ kind: "allowed" });
    // 陰性対照: S に via の無い人は親に書けない。
    const other = readers(s);
    expect(
      judgeCreateParentAccess({
        manifest: manifest(),
        tableId: "tasks",
        values: { title: "新しい作業", project: "P1" },
        actorId: "u-guest",
        readRows: other.readRows,
        readRow: other.readRow,
      }).kind,
    ).toBe("denied");
  });

  test("(U-9) 付与の書込の親の読取の検査: 相手の人ごとに読み替える(S 経由で親を読める人へは子の付与を配れる)", () => {
    const s = store();
    const { readRows, readRow } = readers(s);
    expect(
      judgeGrantWrite({
        manifest: manifest(),
        tableId: "task_grants",
        op: "create",
        values: { task: "T1", member: "m-expert", permission: "t_admin" },
        actorId: "u-admin",
        role: ["staff"],
        readRows,
        readRow,
      }),
    ).toEqual({ kind: "allowed" });
    // 陰性対照: 親を読めない人(名簿だけ)へは今日どおり断る。
    const other = readers(s);
    expect(
      judgeGrantWrite({
        manifest: manifest(),
        tableId: "task_grants",
        op: "create",
        values: { task: "T1", member: "m-out", permission: "t_admin" },
        actorId: "u-admin",
        role: ["staff"],
        readRows: other.readRows,
        readRow: other.readRow,
      })?.kind,
    ).toBe("parent_denied");
  });

  test("(U-10) 付与の書込の 404 と 403 の読み分け: S 経由で R を読める人(作成者でない)には 403 の側", () => {
    const s = store();
    const { readRows, readRow } = readers(s);
    expect(
      judgeGrantWrite({
        manifest: manifest(),
        tableId: "project_grants",
        op: "create",
        values: { project: "P1", member: "m-out", permission: "p_worker" },
        actorId: "u-expert",
        role: ["staff"],
        readRows,
        readRow,
      })?.kind,
    ).toBe("not_creator");
    // 陰性対照: R を読めない人には今日どおり 404 の側。
    const other = readers(s);
    expect(
      judgeGrantWrite({
        manifest: manifest(),
        tableId: "project_grants",
        op: "create",
        values: { project: "P1", member: "m-out", permission: "p_worker" },
        actorId: "u-guest",
        role: ["staff"],
        readRows: other.readRows,
        readRow: other.readRow,
      })?.kind,
    ).toBe("invisible_target");
  });
});

describe("(C) 閉じる側", () => {
  test("(C-1) S の親(inherit_from)は辿らない: S の親の管理者は S を読めても R は読めない", () => {
    expect(access(store(), "units", "A1", "u-net").read).toBe(true);
    expect(access(store(), "projects", "P1", "u-net")).toEqual(NONE);
  });

  test("(C-2) S 側の principal_row は辿らない(1段だけ)", () => {
    // 適用時には断られる形(S の付与にも principal_row)を、判定の家に直に渡す。
    const m = manifest() as unknown as {
      app: { tables: { id: string; fields: Row[]; access_control?: Record<string, unknown> }[] };
    };
    const units = m.app.tables.find((table) => table.id === "units") as unknown as {
      access_control: { grant: Record<string, unknown> };
    };
    const grant = units.access_control.grant;
    grant.principal_row = { column: "club", table: "clubs", via: ["club_member"] };
    m.app.tables.find((table) => table.id === "unit_grants")?.fields.push(ref("club", "clubs"));
    m.app.tables.push(
      {
        id: "clubs",
        fields: [{ id: "title", name: "名前", type: "text" }],
        access_control: {
          enabled: true,
          permissions: [
            { id: "club_member", name: "会員", read: true, write: false, delete: false },
          ],
          creator_permission: "club_member",
          grant: {
            table: "club_grants",
            target: "club",
            member: "member",
            permission: "permission",
          },
          members: { table: "members", account: "account" },
        },
      },
      {
        id: "club_grants",
        fields: [
          ref("club", "clubs"),
          ref("member", "members"),
          { id: "permission", name: "権限", type: "text" },
        ],
      },
    );
    const s = store();
    s.set("clubs", [{ _id: "C1", title: "会1" }]);
    s.set("club_grants", [{ _id: "cg1", club: "C1", member: "m-out", permission: "club_member" }]);
    s.set("unit_grants", [
      ...(s.get("unit_grants") ?? []),
      { _id: "ug9", unit: "A1", club: "C1", permission: "unit_member" },
    ]);
    const twoStep = m as unknown as Manifest;
    // 1段目(S を守る表として見る)は効く —— 読み替えは S の表にも同じ1本で掛かる。
    expect(access(s, "units", "A1", "u-out", twoStep).read).toBe(true);
    // 2段目(S を経由して R)は効かない。
    expect(access(s, "projects", "P1", "u-out", twoStep)).toEqual(NONE);
    // 陰性対照: 1段目の人は今日どおり R を読める。
    expect(access(s, "projects", "P1", "u-expert", twoStep)).toEqual(ALL);
  });

  test("(C-3) S の行が消えたら効かない(付与の行が残っていても)", () => {
    const s = store();
    s.set(
      "units",
      (s.get("units") ?? []).filter((row) => row._id !== "A1"),
    );
    expect(access(s, "projects", "P1", "u-expert")).toEqual(NONE);
  });

  test("(C-4) S の表の宣言が壊れていたら(access_control が切られていたら)効かない", () => {
    const m = manifest() as unknown as { app: { tables: { id: string; access_control?: Row }[] } };
    const units = m.app.tables.find((table) => table.id === "units");
    (units?.access_control as Row).enabled = false;
    expect(access(store(), "projects", "P1", "u-expert", m as unknown as Manifest)).toEqual(NONE);
  });
});

describe("(N) 使わない側(管理の判定は S 経由を見ない)", () => {
  /** 行 A1 へ `p_admin`(作成者の権限・招待の `by`)も配った台。 */
  function adminViaUnit(): Store {
    const s = store();
    s.set("project_grants", [
      ...(s.get("project_grants") ?? []),
      { _id: "pg4", project: "P1", unit: "A1", permission: "p_admin" },
    ]);
    return s;
  }

  test("(N-1) 付与の書込の「作成者か」: S 経由で作成者の権限を持っても作成者ではない(403 の側)", () => {
    const s = adminViaUnit();
    // S 経由で読める・書ける・消せる。
    expect(access(s, "projects", "P1", "u-expert")).toEqual(ALL);
    const { readRows, readRow } = readers(s);
    expect(
      judgeGrantWrite({
        manifest: manifest(),
        tableId: "project_grants",
        op: "create",
        values: { project: "P1", member: "m-out", permission: "p_worker" },
        actorId: "u-expert",
        role: ["staff"],
        readRows,
        readRow,
      })?.kind,
    ).toBe("not_creator");
  });

  test("(N-2) 最後の管理者: S 経由の作成者は数えない", () => {
    const s = adminViaUnit();
    const { readRows } = readers(s);
    expect(
      lastRowAdminVanishes({
        manifest: manifest(),
        readRows,
        userExists: () => true,
        removed: [{ tableId: "project_grants", recordId: "pg1" }],
      }),
    ).toBe(true);
  });

  test("(N-3) 招待の発行権と管理権: S 経由で by(p_admin)を持っても出せない・見られない", () => {
    const s = adminViaUnit();
    const { readRows } = readers(s);
    const answer = rowInvitationAccess({
      manifest: manifest(),
      tableId: "projects",
      subject: { recordId: "P1", actorId: "u-expert", role: ["staff"], readRows },
    });
    expect(answer?.issue).toBe(false);
    expect(answer?.manage).toBe(false);
    // 陰性対照: 直接持つ管理者は出せる。
    const admin = rowInvitationAccess({
      manifest: manifest(),
      tableId: "projects",
      subject: {
        recordId: "P1",
        actorId: "u-admin",
        role: ["staff"],
        readRows: readers(s).readRows,
      },
    });
    expect(admin?.issue).toBe(true);
  });

  test("(N-4) 作成者付与の下見(作成の口・一括の口・付与の書込の面の関門)は読み替えを通らない(源の形)", async () => {
    const source = await Bun.file(new URL("./owner-scope.ts", import.meta.url)).text();
    const app = await Bun.file(new URL("./app.ts", import.meta.url)).text();
    const body = (name: string): string => {
      const at = source.indexOf(`function ${name}(`);
      expect(at).toBeGreaterThan(0);
      return source.slice(at, source.indexOf("\n}\n", at));
    };
    for (const name of [
      "creatorGrantPlan",
      "grantWriteFacesBlock",
      "lastRowAdminVanishes",
      "rowHasAdmin",
      "rowInvitationAccess",
      "accessRegistryVisibleIds",
    ]) {
      expect(body(name).includes("principalRowGrantRows(")).toBe(false);
    }
    // 下見2か所(作成の口・一括の口)は app.ts にあり、読み替えの名前を1度も綴らない。
    expect(app.includes("principalRowGrantRows")).toBe(false);
    // 使う側の5か所はそれぞれ1度ずつ呼ぶ。
    for (const name of [
      "resolveRecordAccess",
      "resolveRecordAccessSources",
      "grantedPermissionNamesForCreate",
      "judgeGrantParentAccess",
    ]) {
      expect(body(name).split("principalRowGrantRows(").length - 1).toBe(1);
    }
    const write = body("judgeGrantWrite");
    expect(write.split("principalRowGrantRows(").length - 1).toBe(1);
  });
});

describe("(Q) 数え方", () => {
  test("(Q-1) 引き継ぎの行数の数えに S 側の読みを入れない(S 側に1000行を超える付与があっても上限に当たらない)", () => {
    const s = store();
    const noise: Row[] = [];
    for (let i = 0; i < 1500; i += 1) {
      noise.push({ _id: `ugn${i}`, unit: "A2", member: "m-out", permission: "unit_guest" });
    }
    s.set("unit_grants", [...(s.get("unit_grants") ?? []), ...noise]);
    expect(access(s, "tasks", "T1", "u-expert")).toEqual(ALL);
  });

  test("(Q-2) 引き継ぎの行数の上限は今日どおり R 側の読みで当たる(数え方は変わらない)", () => {
    for (const principalRow of [true, false]) {
      const s = store();
      const noise: Row[] = [];
      for (let i = 0; i < 1001; i += 1) {
        noise.push({ _id: `pgn${i}`, project: "P2", member: "m-out", permission: "p_worker" });
      }
      s.set("project_grants", [...(s.get("project_grants") ?? []), ...noise]);
      const { readRows, readRow } = readers(s);
      const resolved = resolveRecordAccess({
        manifest: manifest({ principalRow }),
        tableId: "tasks",
        row: readRow("tasks", "T1") as Row,
        actorId: "u-expert",
        readRows,
        readRow,
      });
      expect(resolved).toEqual({ kind: "limit_exceeded", limit: "rows" });
    }
  });

  test("(Q-3) principal_row の無いアプリでは S 側の表を1本も読まない(読みの回数の陰性対照)", () => {
    const s = store();
    const { readRows, readRow, counts } = readers(s);
    for (const id of ["P1", "P2"]) {
      resolveRecordAccess({
        manifest: manifest({ principalRow: false }),
        tableId: "projects",
        row: readRow("projects", id) as Row,
        actorId: "u-expert",
        readRows,
        readRow,
      });
    }
    expect([...counts.keys()].sort()).toEqual(["members", "project_grants"]);
  });

  test("(Q-4) S 側の解決は1つの要求の中で S の1行につき1回(覚えておく)", () => {
    const s = store();
    const projects: Row[] = [];
    const grants: Row[] = [];
    for (let i = 0; i < 20; i += 1) {
      projects.push({ _id: `PX${i}`, title: `案件${i}` });
      grants.push({
        _id: `pgx${i}`,
        project: `PX${i}`,
        unit: i % 2 === 0 ? "A1" : "A2",
        permission: "p_worker",
      });
    }
    s.set("projects", projects);
    s.set("project_grants", grants);
    const { readRows, readRow, counts } = readers(s);
    let readable = 0;
    for (const row of projects) {
      const resolved = resolveRecordAccess({
        manifest: manifest(),
        tableId: "projects",
        row,
        actorId: "u-expert",
        readRows,
        readRow,
      });
      if (resolved.kind === "verdict" && resolved.verdict.read) {
        readable += 1;
      }
    }
    expect(readable).toBe(10);
    // S の行は A1・A2 の2つ。 S の付与表を読むのは S の1行につき1回。
    expect(counts.get("unit_grants")).toBe(2);
    // 守る表の付与表は今日どおり R の行ごとに読む(読む手の覚えは呼ぶ側の仕事)。
    expect(counts.get("project_grants")).toBe(20);
  });
});

// =====================================================================================
// 【独立点検の処置(重1)】via の違う2つの守る表が同じ S を指すとき、S 側の覚えを取り違えない
// =====================================================================================

describe("(V) via の違う守る表どうし(同じ読む手で順に解く)", () => {
  /**
   * 題材: 案件は `via` が `unit_member`・`unit_lead`、作業は `via` が `unit_guest`(同じ部隊 A1 を指す)。
   * `u-guest` は A1 に `unit_guest` だけ。 作業 T1 に「相手 = A1・`p_worker`」の付与、作業 T2 には付与が無い
   * (親の案件 P1 に A1 への `p_worker` があるが、案件の `via` に `unit_guest` は無い)。
   * `u-expert` は A1 に `unit_member` だけ(案件は読めるが、作業 T1 の付与は `via` が違うので効かない)。
   */
  function viaStore(): Store {
    const s = store();
    s.set("tasks", [
      { _id: "T1", title: "作業1", project: "P1" },
      { _id: "T2", title: "作業2", project: "P1" },
    ]);
    s.set("task_grants", [
      { _id: "tg1", task: "T1", member: "m-admin", permission: "t_admin" },
      { _id: "tg2", task: "T1", unit: "A1", permission: "p_worker" },
    ]);
    return s;
  }
  const m = () => manifest({ taskVia: ["unit_guest"] });

  /** 1つの要求の読む手を共有して、並べた行を順に解く。 */
  function sharedReader(s: Store, actor: string, order: readonly [string, string][]) {
    const { readRows, readRow } = readers(s);
    return order.map(([tableId, recordId]) => {
      const resolved = resolveRecordAccess({
        manifest: m(),
        tableId,
        row: readRow(tableId, recordId) as Row,
        actorId: actor,
        readRows,
        readRow,
      });
      if (resolved.kind !== "verdict") {
        throw new Error(`上限に当たった: ${resolved.limit}`);
      }
      return resolved.verdict;
    });
  }

  test("(V-0) 毎回読む手を作り直すときの答え(以下の基準)", () => {
    const s = viaStore();
    expect(access(s, "tasks", "T1", "u-guest", m()).read).toBe(true);
    expect(access(s, "tasks", "T2", "u-guest", m())).toEqual(NONE);
    expect(access(s, "projects", "P1", "u-guest", m())).toEqual(NONE);
    expect(access(s, "projects", "P1", "u-expert", m())).toEqual(ALL);
    expect(access(s, "tasks", "T1", "u-expert", m()).read).toBe(true); // 親の案件 P1 から引き継ぐ
  });

  test("(V-1) 作業 T1 を解いた後でも、作業 T2 と案件 P1 は読めない(覚えで権限が上がらない)", () => {
    const [t1, t2, p1] = sharedReader(viaStore(), "u-guest", [
      ["tasks", "T1"],
      ["tasks", "T2"],
      ["projects", "P1"],
    ]);
    expect(t1?.read).toBe(true);
    expect(t2).toEqual(NONE);
    expect(p1).toEqual(NONE);
  });

  test("(V-2) 逆順: 案件 P1 を解いた後でも、作業 T1 は読める(覚えで権限が下がらない)", () => {
    const [p1, t1] = sharedReader(viaStore(), "u-guest", [
      ["projects", "P1"],
      ["tasks", "T1"],
    ]);
    expect(p1).toEqual(NONE);
    expect(t1?.read).toBe(true);
  });

  test("(V-3) 所属(unit_member)の人: 案件 P1 を解いた後に、作業 T2 の答えが毎回作り直すときと同じ", () => {
    const s = viaStore();
    const [p1, t2] = sharedReader(s, "u-expert", [
      ["projects", "P1"],
      ["tasks", "T2"],
    ]);
    expect(p1).toEqual(ALL);
    expect(t2).toEqual(access(s, "tasks", "T2", "u-expert", m()));
  });
});
