/**
 * **`V18-M7-T01` / `PM-G5`(`ADR-0444` 授権の表 行1)**:
 * **親にぶら下がる子を、いちばん下の段まで数え、「この人に消せるか」を判定する述語を固定する。**
 *
 * ## 何を測るか(計画 `docs/plan/v18/09-v18-m7-plan.md` の `V18-M7-T01` 完了条件の逐語)
 *
 * > (a) **`inherit_from` を1本も宣言していないアプリで 0件 を返すことを検査が固定している**
 * >     (素通りの担保)。
 * > (b) **`inherit_from` が2本ある表で、両方の親を別々に数えられることを固定している。**
 * > (c) **3段(親 → 子 → 孫)で、孫まで数えることを固定している**(**`D-V18-32`**)。
 * > (d) **子のうち1件でも消せない人には「消せない」を返すことを固定している**(**`D-V18-31`**)。
 * > (e) **環(自分が自分の親)で止まることを固定している。**
 * > (f) **段数・行数の上限に当たったときの返り値が決まっており、検査が固定している。**
 * > (g) **消す順序が、深い段から浅い段の向きである。**
 *
 * ## **本ファイルが叩くもの**
 *
 * **`owner-scope.ts` の `resolveRecordDeleteCascade` を**直接**呼ぶ。**
 * **述語は純関数であり、DB を1バイトも触らない** —— **行の読み出し(`readRows`)と
 * 「この子をこの人が消せるか」の判定(`judgeChildDelete`)は、どちらも呼び出し側から
 * 関数として渡す**(`ADR-0444` 授権の表 行1 の逐語「純関数。行の読み出しは呼び出し側から渡す」)。
 * **したがって本ファイルは `Database` も `createServerApp` も1度も使わない。**
 *
 * ## **【誇張しない。本ファイルが測っていないこと】**
 *
 *  1. **HTTP の `DELETE` にも AI の口にも1度も当てていない**(`V18-M7-T02` / `T03` の担当)。
 *     **本ファイルが緑でも、今日の削除は親だけを消して子を残したままである。**
 *  2. **`judgeChildDelete` の**中身**を1件も測っていない** —— **本述語はそれを呼ぶだけであり、
 *     「その子を直接消そうとしたときに通る関門」を組み立てるのは呼び出し側である**
 *     (`ADR-0444` §Decision 3 の ③)。
 *  3. **性能を1件も測っていない。** **上限の値(5段 / 1000行)に実測の根拠は1件も無い。**
 *  4. **実地データを1度も開いていない。**
 */
import { describe, expect, test } from "bun:test";
import type { Manifest } from "../kernel/index.ts";
import { resolveRecordDeleteCascade } from "./owner-scope.ts";

/** 権限名2つ(既存の台 `access-control-inheritance.test.ts` と同じ形)。 */
const PERMISSIONS = [
  { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
  { id: "writer", name: "編集できる", read: true, write: true, delete: true },
] as const;

/** どの表も同じ形の宣言を持つ(**各段で適用する規則は同一**。`Z-G14` 限定3)。 */
function declaration(target: string, inheritFrom?: readonly string[]): Record<string, unknown> {
  return {
    enabled: true,
    permissions: PERMISSIONS.map((permission) => ({ ...permission })),
    creator_permission: "writer",
    grant: { table: "ac_grant", target, member: "member", permission: "permission" },
    members: { table: "ac_member", account: "account" },
    ...(inheritFrom === undefined ? {} : { inherit_from: [...inheritFrom] }),
  };
}

function reference(id: string, table: string): Record<string, unknown> {
  return { id, name: id, type: "reference", reference_table: table };
}

function manifestOf(tables: readonly Record<string, unknown>[]): Manifest {
  return {
    app: { id: "cascade-probe", name: "連鎖の台", tables: [...tables] },
  } as unknown as Manifest;
}

/** **行の読み出しを数える台。** **述語が同じ表を何度走査したかが分かる。** */
function store(rows: Record<string, readonly Record<string, unknown>[]>): {
  readonly reads: string[];
  readonly readRows: (tableId: string) => readonly Record<string, unknown>[];
} {
  const reads: string[] = [];
  return {
    reads,
    readRows: (tableId: string) => {
      reads.push(tableId);
      return rows[tableId] ?? [];
    },
  };
}

/** **全部の子を消せる人**(`ADR-0444` §Decision 3 の ③ に当たらない側)。 */
const deletableAlways = (): boolean => true;

// =====================================================================================
// **3段の台**(親 `projects` → 子 `issues` → 孫 `comments`)。
// **既存の台 `access-control-inheritance.test.ts` の3段にそのまま倣った** ——
// **表ID(`projects` / `issues` / `comments`)と参照項目(`project` / `issue`)まで同じである。**
// **`solo_issues` は「参照は持つが `inherit_from` を1本も宣言していない表」であり、
// あちらの台と同じく「参照を書いただけでは子にならない」の対照として置いてある。**
// =====================================================================================

function threeLevelManifest(): Manifest {
  return manifestOf([
    {
      id: "projects",
      name: "プロジェクト",
      fields: [{ id: "title", name: "名前", type: "text", required: true }],
      access_control: declaration("project"),
    },
    {
      id: "issues",
      name: "課題",
      fields: [
        { id: "title", name: "件名", type: "text", required: true },
        reference("project", "projects"),
      ],
      access_control: declaration("issue", ["project"]),
    },
    {
      id: "comments",
      name: "コメント",
      fields: [
        { id: "body", name: "本文", type: "text", required: true },
        reference("issue", "issues"),
      ],
      access_control: declaration("comment", ["issue"]),
    },
    {
      id: "solo_issues",
      name: "引き継がない課題",
      fields: [
        { id: "title", name: "件名", type: "text", required: true },
        reference("project", "projects"),
      ],
      access_control: declaration("solo"),
    },
  ]);
}

/** 3段の行。**`p1` の下に課題2件、その下にコメント3件。`p2` の下は空である。** */
function threeLevelRows(): Record<string, readonly Record<string, unknown>[]> {
  return {
    projects: [
      { _id: "p1", title: "本命" },
      { _id: "p2", title: "別件" },
    ],
    issues: [
      { _id: "i1", title: "課題1", project: "p1" },
      { _id: "i2", title: "課題2", project: "p1" },
      { _id: "i9", title: "他所の課題", project: "p2" },
    ],
    comments: [
      { _id: "c1", body: "一言", issue: "i1" },
      { _id: "c2", body: "二言", issue: "i1" },
      { _id: "c3", body: "三言", issue: "i2" },
      { _id: "c9", body: "他所の一言", issue: "i9" },
    ],
    solo_issues: [{ _id: "s1", title: "引き継がない", project: "p1" }],
  };
}

describe("V18-M7-T01 (a): inherit_from を1本も宣言していないアプリでは 0件 である", () => {
  test("(a-1) 参照を書いただけの表は子にならない(素通りの担保)", () => {
    const manifest = manifestOf([
      {
        id: "projects",
        name: "プロジェクト",
        fields: [{ id: "title", name: "名前", type: "text", required: true }],
        access_control: declaration("project"),
      },
      {
        id: "solo_issues",
        name: "引き継がない課題",
        fields: [
          { id: "title", name: "件名", type: "text", required: true },
          reference("project", "projects"),
        ],
        access_control: declaration("solo"),
      },
    ]);
    const rows = store({
      projects: [{ _id: "p1", title: "本命" }],
      solo_issues: [
        { _id: "s1", title: "1件目", project: "p1" },
        { _id: "s2", title: "2件目", project: "p1" },
      ],
    });
    const resolved = resolveRecordDeleteCascade({
      manifest,
      tableId: "projects",
      recordId: "p1",
      readRows: rows.readRows,
      judgeChildDelete: deletableAlways,
    });
    expect(resolved).toEqual({
      kind: "cascade",
      total: 0,
      perTable: [],
      hasUndeletableChild: false,
      deleteOrder: [],
    });
  });

  test("(a-2) access_control を1つも持たないアプリでも 0件 で、行を1度も読まない", () => {
    const manifest = manifestOf([
      {
        id: "memos",
        name: "メモ",
        fields: [{ id: "body", name: "本文", type: "text", required: true }],
      },
    ]);
    const rows = store({ memos: [{ _id: "m1", body: "ひとつ" }] });
    const resolved = resolveRecordDeleteCascade({
      manifest,
      tableId: "memos",
      recordId: "m1",
      readRows: rows.readRows,
      judgeChildDelete: deletableAlways,
    });
    expect(resolved.kind).toBe("cascade");
    expect(resolved.kind === "cascade" ? resolved.total : -1).toBe(0);
    // **子の表が1本も無いので、行の読み出しは1度も起きない。**
    expect(rows.reads).toEqual([]);
  });
});

describe("V18-M7-T01 (b): inherit_from が2本ある表で、両方の親を別々に数える", () => {
  // **2本が設計図の上限である**(`apps/smailtalk/schemas/manifest.schema.json:638` の
  // `"maxItems": 2`)。**本段はその値を1文字も動かしていない。**
  function twoParentManifest(): Manifest {
    return manifestOf([
      {
        id: "projects",
        name: "プロジェクト",
        fields: [{ id: "title", name: "名前", type: "text", required: true }],
        access_control: declaration("project"),
      },
      {
        id: "sprints",
        name: "期間",
        fields: [{ id: "title", name: "名前", type: "text", required: true }],
        access_control: declaration("sprint"),
      },
      {
        id: "tasks",
        name: "作業",
        fields: [
          { id: "title", name: "件名", type: "text", required: true },
          reference("project", "projects"),
          reference("sprint", "sprints"),
        ],
        access_control: declaration("task", ["project", "sprint"]),
      },
    ]);
  }

  const taskRows = {
    projects: [{ _id: "p1" }, { _id: "p2" }],
    sprints: [{ _id: "s1" }, { _id: "s2" }],
    tasks: [
      { _id: "t1", project: "p1", sprint: "s1" },
      { _id: "t2", project: "p1", sprint: "s2" },
      { _id: "t3", project: "p2", sprint: "s1" },
    ],
  };

  test("(b-1) 片方の親から数えると、その親を指している行だけが数に入る", () => {
    const rows = store(taskRows);
    const resolved = resolveRecordDeleteCascade({
      manifest: twoParentManifest(),
      tableId: "projects",
      recordId: "p1",
      readRows: rows.readRows,
      judgeChildDelete: deletableAlways,
    });
    expect(resolved).toEqual({
      kind: "cascade",
      total: 2,
      perTable: [{ tableId: "tasks", count: 2 }],
      hasUndeletableChild: false,
      deleteOrder: [
        { tableId: "tasks", recordId: "t1", depth: 1 },
        { tableId: "tasks", recordId: "t2", depth: 1 },
      ],
    });
  });

  test("(b-2) もう片方の親から数えると、別の集合が返る", () => {
    const rows = store(taskRows);
    const resolved = resolveRecordDeleteCascade({
      manifest: twoParentManifest(),
      tableId: "sprints",
      recordId: "s1",
      readRows: rows.readRows,
      judgeChildDelete: deletableAlways,
    });
    expect(resolved).toEqual({
      kind: "cascade",
      total: 2,
      perTable: [{ tableId: "tasks", count: 2 }],
      hasUndeletableChild: false,
      deleteOrder: [
        { tableId: "tasks", recordId: "t1", depth: 1 },
        { tableId: "tasks", recordId: "t3", depth: 1 },
      ],
    });
  });

  test("(b-3) どちらの親も指していない行は、どちらから数えても入らない", () => {
    const rows = store({ ...taskRows, tasks: [{ _id: "t0" }, ...taskRows.tasks] });
    const fromProject = resolveRecordDeleteCascade({
      manifest: twoParentManifest(),
      tableId: "projects",
      recordId: "p2",
      readRows: rows.readRows,
      judgeChildDelete: deletableAlways,
    });
    expect(fromProject.kind === "cascade" ? fromProject.total : -1).toBe(1);
  });
});

describe("V18-M7-T01 (c): 3段(親 → 子 → 孫)で、孫まで数える(D-V18-32)", () => {
  test("(c-1) 合計と、表ごとの件数の両方が返る", () => {
    const rows = store(threeLevelRows());
    const resolved = resolveRecordDeleteCascade({
      manifest: threeLevelManifest(),
      tableId: "projects",
      recordId: "p1",
      readRows: rows.readRows,
      judgeChildDelete: deletableAlways,
    });
    expect(resolved.kind).toBe("cascade");
    if (resolved.kind !== "cascade") {
      return;
    }
    // **課題2件 + コメント3件 = 5件。** **`solo_issues` の1件は入らない。**
    expect(resolved.total).toBe(5);
    expect(resolved.perTable).toEqual([
      { tableId: "issues", count: 2 },
      { tableId: "comments", count: 3 },
    ]);
    expect(resolved.hasUndeletableChild).toBe(false);
  });

  test("(c-2) 別の親の下にぶら下がる孫は、1件も数に入らない", () => {
    const rows = store(threeLevelRows());
    const resolved = resolveRecordDeleteCascade({
      manifest: threeLevelManifest(),
      tableId: "projects",
      recordId: "p2",
      readRows: rows.readRows,
      judgeChildDelete: deletableAlways,
    });
    expect(resolved.kind === "cascade" ? resolved.total : -1).toBe(2); // i9 と c9 だけ
    expect(
      resolved.kind === "cascade" ? resolved.deleteOrder.map((entry) => entry.recordId) : [],
    ).toEqual(["c9", "i9"]);
  });

  test("(c-3) いちばん下の段から数え始めると、その下だけが返る", () => {
    const rows = store(threeLevelRows());
    const resolved = resolveRecordDeleteCascade({
      manifest: threeLevelManifest(),
      tableId: "issues",
      recordId: "i1",
      readRows: rows.readRows,
      judgeChildDelete: deletableAlways,
    });
    expect(resolved.kind === "cascade" ? resolved.total : -1).toBe(2);
    expect(resolved.kind === "cascade" ? resolved.perTable : []).toEqual([
      { tableId: "comments", count: 2 },
    ]);
  });
});

describe("V18-M7-T01 (d): 子のうち1件でも消せないなら、その事実を返す(D-V18-31)", () => {
  test("(d-1) 孫が1件だけ消せない人には hasUndeletableChild が真で返る", () => {
    const rows = store(threeLevelRows());
    const judged: string[] = [];
    const resolved = resolveRecordDeleteCascade({
      manifest: threeLevelManifest(),
      tableId: "projects",
      recordId: "p1",
      readRows: rows.readRows,
      judgeChildDelete: (child) => {
        judged.push(`${child.tableId}/${String(child.row._id)}@${String(child.depth)}`);
        return child.row._id !== "c2";
      },
    });
    expect(resolved.kind).toBe("cascade");
    if (resolved.kind !== "cascade") {
      return;
    }
    expect(resolved.hasUndeletableChild).toBe(true);
    // **件数は落ちない** —— **「消せない子が在る」ことと「何件ぶら下がっているか」は別である。**
    expect(resolved.total).toBe(5);
    // **子1件につき1度ずつ問う。** **1件目が偽でも打ち切らない**(件数が欠けないため)。
    expect(judged.length).toBe(5);
    expect(judged).toEqual([
      "issues/i1@1",
      "issues/i2@1",
      "comments/c1@2",
      "comments/c2@2",
      "comments/c3@2",
    ]);
  });

  test("(d-2) 全部消せる人では偽である(陽性対照)", () => {
    const rows = store(threeLevelRows());
    const resolved = resolveRecordDeleteCascade({
      manifest: threeLevelManifest(),
      tableId: "projects",
      recordId: "p1",
      readRows: rows.readRows,
      judgeChildDelete: deletableAlways,
    });
    expect(resolved.kind === "cascade" ? resolved.hasUndeletableChild : true).toBe(false);
  });

  test("(d-3) 子が0件なら、判定は1度も呼ばれない", () => {
    const rows = store(threeLevelRows());
    let calls = 0;
    const resolved = resolveRecordDeleteCascade({
      manifest: threeLevelManifest(),
      tableId: "comments",
      recordId: "c1",
      readRows: rows.readRows,
      judgeChildDelete: () => {
        calls += 1;
        return true;
      },
    });
    expect(resolved.kind === "cascade" ? resolved.total : -1).toBe(0);
    expect(resolved.kind === "cascade" ? resolved.hasUndeletableChild : true).toBe(false);
    expect(calls).toBe(0);
  });
});

describe("V18-M7-T01 (e): 環(自分が自分の親)で止まる", () => {
  function selfParentManifest(): Manifest {
    return manifestOf([
      {
        id: "nodes",
        name: "節",
        fields: [{ id: "title", name: "名前", type: "text" }, reference("parent", "nodes")],
        access_control: declaration("node", ["parent"]),
      },
    ]);
  }

  test("(e-1) 自分が自分の親である行は、自分の子には入らない", () => {
    const rows = store({ nodes: [{ _id: "n1", parent: "n1" }] });
    const resolved = resolveRecordDeleteCascade({
      manifest: selfParentManifest(),
      tableId: "nodes",
      recordId: "n1",
      readRows: rows.readRows,
      judgeChildDelete: deletableAlways,
    });
    expect(resolved).toEqual({
      kind: "cascade",
      total: 0,
      perTable: [],
      hasUndeletableChild: false,
      deleteOrder: [],
    });
  });

  test("(e-2) 2つの行が互いを親にしていても、正常に完了する(拒否に落ちない)", () => {
    const rows = store({
      nodes: [
        { _id: "n1", parent: "n2" },
        { _id: "n2", parent: "n1" },
      ],
    });
    const resolved = resolveRecordDeleteCascade({
      manifest: selfParentManifest(),
      tableId: "nodes",
      recordId: "n1",
      readRows: rows.readRows,
      judgeChildDelete: deletableAlways,
    });
    // **`n1` の子は `n2` の1件だけである** —— **`n2` の子は `n1` だが、訪問済みなので
    // 2度目は数えない。** **`limit_exceeded` にも落ちない**(環は上限より先に訪問済み集合が
    // 止める。`Z-G16` の優先順位と同じ)。
    expect(resolved).toEqual({
      kind: "cascade",
      total: 1,
      perTable: [{ tableId: "nodes", count: 1 }],
      hasUndeletableChild: false,
      deleteOrder: [{ tableId: "nodes", recordId: "n2", depth: 1 }],
    });
  });

  test("(e-3) 3つの行の環でも正常に完了する", () => {
    const rows = store({
      nodes: [
        { _id: "n1", parent: "n3" },
        { _id: "n2", parent: "n1" },
        { _id: "n3", parent: "n2" },
      ],
    });
    const resolved = resolveRecordDeleteCascade({
      manifest: selfParentManifest(),
      tableId: "nodes",
      recordId: "n1",
      readRows: rows.readRows,
      judgeChildDelete: deletableAlways,
    });
    expect(resolved.kind === "cascade" ? resolved.total : -1).toBe(2);
  });
});

describe("V18-M7-T01 (f): 段数・行数の上限に当たったときの返り値", () => {
  /** `levels` 段の鎖を作る(`lv0` が根、`lv{n}` が `lv{n-1}` の子)。 */
  function chainManifest(levels: number): Manifest {
    const tables: Record<string, unknown>[] = [];
    for (let index = 0; index <= levels; index += 1) {
      tables.push({
        id: `lv${String(index)}`,
        name: `段${String(index)}`,
        fields:
          index === 0
            ? [{ id: "title", name: "名前", type: "text" }]
            : [reference("up", `lv${String(index - 1)}`)],
        access_control:
          index === 0
            ? declaration(`lv${String(index)}`)
            : declaration(`lv${String(index)}`, ["up"]),
      });
    }
    return manifestOf(tables);
  }

  /** `rows` 段ぶんの行を作る(段 `i` の行 `r{i}` が段 `i-1` の行 `r{i-1}` を指す)。 */
  function chainRows(levels: number): Record<string, readonly Record<string, unknown>[]> {
    const rows: Record<string, readonly Record<string, unknown>[]> = {};
    for (let index = 0; index <= levels; index += 1) {
      rows[`lv${String(index)}`] =
        index === 0 ? [{ _id: "r0" }] : [{ _id: `r${String(index)}`, up: `r${String(index - 1)}` }];
    }
    return rows;
  }

  test("(f-1) 段5 までは辿れる(上限のすぐ手前で正常に完了する)", () => {
    const rows = store(chainRows(5));
    const resolved = resolveRecordDeleteCascade({
      manifest: chainManifest(5),
      tableId: "lv0",
      recordId: "r0",
      readRows: rows.readRows,
      judgeChildDelete: deletableAlways,
    });
    expect(resolved.kind === "cascade" ? resolved.total : -1).toBe(5);
    expect(resolved.kind === "cascade" ? resolved.deleteOrder[0]?.depth : -1).toBe(5);
  });

  test("(f-2) 段6 に進もうとしたら limit_exceeded / depth である", () => {
    const rows = store(chainRows(6));
    const resolved = resolveRecordDeleteCascade({
      manifest: chainManifest(6),
      tableId: "lv0",
      recordId: "r0",
      readRows: rows.readRows,
      judgeChildDelete: deletableAlways,
    });
    // **既存の `resolveRecordAccess` と1バイトも同じ形である**(新しい断り方を作っていない)。
    expect(resolved).toEqual({ kind: "limit_exceeded", limit: "depth" });
  });

  test("(f-3) 数えた子がちょうど 1000 件なら、正常に完了する(境界のすぐ手前)", () => {
    const children: Record<string, unknown>[] = [];
    for (let index = 0; index < 1000; index += 1) {
      children.push({ _id: `i${String(index)}`, project: "p1" });
    }
    const rows = store({ projects: [{ _id: "p1" }], issues: children, comments: [] });
    const resolved = resolveRecordDeleteCascade({
      manifest: threeLevelManifest(),
      tableId: "projects",
      recordId: "p1",
      readRows: rows.readRows,
      judgeChildDelete: deletableAlways,
    });
    expect(resolved.kind === "cascade" ? resolved.total : -1).toBe(1000);
  });

  test("(f-4) 1001 件目で limit_exceeded / rows である", () => {
    const children: Record<string, unknown>[] = [];
    for (let index = 0; index < 1001; index += 1) {
      children.push({ _id: `i${String(index)}`, project: "p1" });
    }
    const rows = store({ projects: [{ _id: "p1" }], issues: children, comments: [] });
    const resolved = resolveRecordDeleteCascade({
      manifest: threeLevelManifest(),
      tableId: "projects",
      recordId: "p1",
      readRows: rows.readRows,
      judgeChildDelete: deletableAlways,
    });
    expect(resolved).toEqual({ kind: "limit_exceeded", limit: "rows" });
  });
});

describe("V18-M7-T01 (g): 消す順序は、深い段から浅い段の向きである", () => {
  test("(g-1) 3段では 孫 → 子 の順で並ぶ", () => {
    const rows = store(threeLevelRows());
    const resolved = resolveRecordDeleteCascade({
      manifest: threeLevelManifest(),
      tableId: "projects",
      recordId: "p1",
      readRows: rows.readRows,
      judgeChildDelete: deletableAlways,
    });
    expect(resolved.kind).toBe("cascade");
    if (resolved.kind !== "cascade") {
      return;
    }
    expect(resolved.deleteOrder).toEqual([
      { tableId: "comments", recordId: "c1", depth: 2 },
      { tableId: "comments", recordId: "c2", depth: 2 },
      { tableId: "comments", recordId: "c3", depth: 2 },
      { tableId: "issues", recordId: "i1", depth: 1 },
      { tableId: "issues", recordId: "i2", depth: 1 },
    ]);
    // **段が単調に減る**(浅い段が深い段より先に来ることが1度も無い)。
    const depths = resolved.deleteOrder.map((entry) => entry.depth);
    expect(depths).toEqual([...depths].sort((left, right) => right - left));
    // **親そのものは並びに入らない** —— **親を消すのは呼び出し側であり、最後である。**
    expect(resolved.deleteOrder.some((entry) => entry.recordId === "p1")).toBe(false);
  });

  test("(g-2) 件数の合計と、並びの長さが一致する", () => {
    const rows = store(threeLevelRows());
    const resolved = resolveRecordDeleteCascade({
      manifest: threeLevelManifest(),
      tableId: "projects",
      recordId: "p1",
      readRows: rows.readRows,
      judgeChildDelete: deletableAlways,
    });
    expect(resolved.kind).toBe("cascade");
    if (resolved.kind !== "cascade") {
      return;
    }
    expect(resolved.deleteOrder.length).toBe(resolved.total);
    expect(resolved.perTable.reduce((sum, entry) => sum + entry.count, 0)).toBe(resolved.total);
  });
});
