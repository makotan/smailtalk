/**
 * **`V7-M4-T02` / `Z-G14`**: **親 → 子 → 孫の3段で付与が届く。**
 *
 * ## 何を測るか(起票の完了条件の逐語)
 *
 * > **(i) プロジェクトに付けた付与だけで、その中の issue とコメントが `API` から見えること
 * > を示す。(ii) 辿った先の行を1件も返していない(`related` が返す行集合が1件も変わらない)
 * > ことを示す。**
 *
 * **(i) は (A)(B) が、(ii) は (G) が測る。**
 *
 * ## **本ファイルが `related` をどう叩いているか(逐語で書く)**
 *
 * **`related` の子一覧は、専用の API を1本も持たない** —— **表示層
 * (`web/src/views/DetailViewRenderer.tsx` の `RelatedList`)が「親条件の等値 filter 1つ」
 * (`related.via == 親の _id`)を付けて**一覧 `GET` の同じ経路**を叩く**(`ADR-0044` §1c /
 * 限定2)。**したがって本ファイルも同じ形の一覧 `GET` を叩く** —— **`related` の宣言
 * (`table` / `via`)をマニフェストから読み出して要求を組むので、宣言と要求がずれない。**
 *
 * ## **【誇張しない。本ファイルが測っていないこと】**
 *
 *  1. **段数と件数の上限を1つも測っていない**(`V7-M4-T04` の担当)。**今日の実装に上限は
 *     1つも無い** —— **止まるのは訪問済み集合(同じ (表, 行) を2度訪れない)だけである。**
 *  2. **循環したときのふるまいに専用の検査を置いていない**(`V7-M4-T03` の担当)。
 *  3. **MCP / 受信口 / ワークフロー / 島は今日も素通りする**(`Z-G21`〜`Z-G24`)——
 *     **引き継ぎを足しても、その5経路に判定は1バイトも掛かっていない。**
 *  4. **性能を1件も測っていない。** **全件をメモリに読む post-filter の上に多段が乗り、
 *     行1件ごとに親を辿るので、計算量は (行数 × 段数) である**(`Z-G14` 限定9)。
 *  5. **`POST`(作成)の下見に引き継ぎを掛けていない** —— **`app.ts` の作成者への自動付与の
 *     下見は今日も `judgeRecordAccess` を直接呼んでおり、親を1段も辿らない。**
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import { resolveRecordAccess } from "./owner-scope.ts";
import { seedSession, TEST_ORIGIN } from "./test-helpers.ts";

const APP_ID = "inherit-tracker";

/** 権限名2つ。**`write` を持つのは `writer` だけである。** */
const PERMISSIONS = [
  { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
  { id: "writer", name: "編集できる", read: true, write: true, delete: false },
] as const;

/** 3段の表がどれも同じ形の宣言を持つ(**各段で適用する規則は同一**。`Z-G14` 限定3)。 */
function declaration(target: string, inheritFrom?: readonly string[]): Record<string, unknown> {
  return {
    enabled: true,
    permissions: [...PERMISSIONS],
    creator_permission: "writer",
    grant: { table: "ac_grant", target, member: "member", permission: "permission" },
    members: { table: "ac_member", account: "account" },
    ...(inheritFrom === undefined ? {} : { inherit_from: [...inheritFrom] }),
  };
}

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "課題管理",
      tables: [
        {
          // 段0(いちばん上の親)。**`inherit_from` を持たない。**
          id: "projects",
          name: "プロジェクト",
          fields: [{ id: "title", name: "名前", type: "text", required: true }],
          access_control: declaration("project"),
        },
        {
          // 段1。**親はプロジェクトである。**
          id: "issues",
          name: "課題",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "project", name: "プロジェクト", type: "reference", reference_table: "projects" },
          ],
          access_control: declaration("issue", ["project"]),
        },
        {
          // 段2。**親は課題であり、祖父はプロジェクトである。**
          id: "comments",
          name: "コメント",
          fields: [
            { id: "body", name: "本文", type: "text", required: true },
            { id: "issue", name: "課題", type: "reference", reference_table: "issues" },
          ],
          access_control: declaration("comment", ["issue"]),
        },
        {
          // **参照は持つが `inherit_from` を1本も宣言していない表**(完了条件6の対照)。
          // **「参照を書いただけでは親にならない」を測る。**
          id: "solo_issues",
          name: "引き継がない課題",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "project", name: "プロジェクト", type: "reference", reference_table: "projects" },
          ],
          access_control: declaration("solo"),
        },
        {
          // **`access_control` を1バイトも宣言していない親**(完了条件4の対照)。
          id: "open_projects",
          name: "宣言していないプロジェクト",
          fields: [{ id: "title", name: "名前", type: "text", required: true }],
        },
        {
          // **その親を `inherit_from` で指す子。** **親が宣言していないので何も届かない。**
          id: "open_issues",
          name: "宣言していない親を持つ課題",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            {
              id: "open_project",
              name: "プロジェクト",
              type: "reference",
              reference_table: "open_projects",
            },
          ],
          access_control: declaration("open_issue", ["open_project"]),
        },
        {
          id: "ac_member",
          name: "利用者",
          fields: [{ id: "account", name: "ログイン", type: "text" }],
        },
        {
          // **付与表は1本である** —— **3段が同じ表を名指しし、対象の列だけが違う。**
          // **読取は要求あたり1度だけ行われる**(配管がメモ化する)。
          id: "ac_grant",
          name: "付与",
          fields: [
            { id: "project", name: "プロジェクト", type: "reference", reference_table: "projects" },
            { id: "issue", name: "課題", type: "reference", reference_table: "issues" },
            { id: "comment", name: "コメント", type: "reference", reference_table: "comments" },
            {
              id: "solo",
              name: "引き継がない課題",
              type: "reference",
              reference_table: "solo_issues",
            },
            {
              id: "open_issue",
              name: "宣言していない親を持つ課題",
              type: "reference",
              reference_table: "open_issues",
            },
            { id: "member", name: "相手", type: "reference", reference_table: "ac_member" },
            { id: "permission", name: "権限", type: "select", options: ["reader", "writer"] },
          ],
        },
      ],
      views: [
        {
          // **`related` の宣言**(`ADR-0044`)。**(G) はこの宣言から要求を組む。**
          id: "project-detail",
          type: "detail_view",
          name: "プロジェクト",
          table: "projects",
          fields: ["title"],
          related: [{ table: "issues", via: "project", columns: ["title"], name: "課題" }],
        },
      ],
    },
  } as unknown as Manifest;
}

let dataRoot = "";
let app: ReturnType<typeof createServerApp>;

/** 親にだけ付与のある人 / 子にだけ付与のある人 / 何も付与の無い人 / 参照だけの人。 */
let inheritor: ReturnType<typeof seedSession>;
let direct: ReturnType<typeof seedSession>;
let none: ReturnType<typeof seedSession>;
let viewer: ReturnType<typeof seedSession>;

/** 行の id。 */
let projectId = "";
let otherProjectId = "";
let issueA = "";
let issueB = "";
let otherIssue = "";
let commentA = "";
let otherComment = "";
let soloIssue = "";
let openProject = "";
let openIssue = "";

/** メンバー行の id(付与をあとから足すために覚えておく)。 */
let directMember = "";

function withDb<T>(run: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

async function get(path: string, cookie: string): Promise<Response> {
  return await app.request(path, { headers: { cookie } });
}

async function listIds(table: string, cookie: string, query = ""): Promise<string[]> {
  const response = await get(`/api/apps/${APP_ID}/tables/${table}/records${query}`, cookie);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { records: { _id: string }[] };
  return body.records.map((record) => record._id);
}

/**
 * **`related` の子一覧を、宣言どおりに1回叩く。**
 *
 * **表示層(`RelatedList`)と同じ形である** —— **親条件の等値 filter 1つだけを付けて、
 * 一覧 `GET` の同じ経路を通す。** **専用の経路は1本も無い。**
 */
async function relatedIds(parentRecordId: string, cookie: string): Promise<string[]> {
  const views = (manifest() as unknown as { app: { views: Record<string, unknown>[] } }).app.views;
  const detail = views.find((view) => view.id === "project-detail") as {
    related: { table: string; via: string }[];
  };
  const declared = detail.related[0] as { table: string; via: string };
  return await listIds(
    declared.table,
    cookie,
    `?filter.${declared.via}=${encodeURIComponent(parentRecordId)}`,
  );
}

function versionOf(table: string, recordId: string): string {
  return withDb((db) => {
    const row = db.query(`SELECT _updated_at FROM ${table} WHERE _id = ?`).get(recordId) as {
      _updated_at: string;
    } | null;
    if (row === null) {
      throw new Error(`行 ${recordId} が ${table} に無い`);
    }
    return row._updated_at;
  });
}

async function patch(
  path: string,
  cookie: string,
  values: Record<string, unknown>,
  ifMatch: string,
): Promise<Response> {
  return await app.request(path, {
    method: "PATCH",
    headers: {
      cookie,
      origin: TEST_ORIGIN,
      "content-type": "application/json",
      "if-match": ifMatch,
    },
    body: JSON.stringify(values),
  });
}

/** 付与を1件足す(**あとから足して、related の行集合が動かないことを測る**)。 */
function addGrant(values: Record<string, unknown>): void {
  const loaded = manifest();
  withDb((db) => {
    const created = createRecord(db, loaded, "ac_grant", values);
    expect(created.ok).toBe(true);
  });
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-aci-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "課題管理", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, manifest()).valid).toBe(true);
  app = createServerApp({ dataRoot });

  // **4人とも `editor`** —— **運営ロールが付与を迂回しないことは `V7-M3` が測った。
  // 本ファイルは引き継ぎだけを測る。**
  inheritor = seedSession(dataRoot, APP_ID, { role: "editor", username: "inheritor" });
  direct = seedSession(dataRoot, APP_ID, { role: "editor", username: "direct" });
  none = seedSession(dataRoot, APP_ID, { role: "editor", username: "none" });
  viewer = seedSession(dataRoot, APP_ID, { role: "editor", username: "viewer" });

  const loaded = manifest();
  withDb((db) => {
    const id = (result: unknown): string => (result as { value: { _id: string } }).value._id;

    projectId = id(createRecord(db, loaded, "projects", { title: "本命" }));
    otherProjectId = id(createRecord(db, loaded, "projects", { title: "別件" }));
    issueA = id(createRecord(db, loaded, "issues", { title: "課題A", project: projectId }));
    issueB = id(createRecord(db, loaded, "issues", { title: "課題B", project: projectId }));
    otherIssue = id(
      createRecord(db, loaded, "issues", { title: "別件の課題", project: otherProjectId }),
    );
    commentA = id(createRecord(db, loaded, "comments", { body: "孫のコメント", issue: issueA }));
    otherComment = id(
      createRecord(db, loaded, "comments", { body: "別件のコメント", issue: otherIssue }),
    );
    soloIssue = id(
      createRecord(db, loaded, "solo_issues", { title: "引き継がない課題", project: projectId }),
    );
    openProject = id(createRecord(db, loaded, "open_projects", { title: "宣言していない親" }));
    openIssue = id(
      createRecord(db, loaded, "open_issues", {
        title: "宣言していない親の子",
        open_project: openProject,
      }),
    );

    // **4人ともメンバー表に行を持つ** —— **「付与が無い」と「メンバー行が無い」を分ける。**
    const member = (account: string): string =>
      id(createRecord(db, loaded, "ac_member", { account }));
    const inheritorMember = member(inheritor.userId);
    directMember = member(direct.userId);
    member(none.userId);
    const viewerMember = member(viewer.userId);

    const grant = (values: Record<string, unknown>): void => {
      const created = createRecord(db, loaded, "ac_grant", values);
      expect(created.ok).toBe(true);
    };
    // **親(プロジェクト)への付与だけを持つ人。** **子・孫への付与は1件も無い。**
    grant({ project: projectId, member: inheritorMember, permission: "writer" });
    // **子(課題)への直接の付与だけを持つ人。** **親への付与は1件も無い。**
    grant({ issue: issueA, member: directMember, permission: "writer" });
    grant({ issue: issueB, member: directMember, permission: "writer" });
    // **親への「参照のみ」の付与を持つ人。**
    grant({ project: projectId, member: viewerMember, permission: "reader" });
  });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (A) 完了条件1 —— **親に付けた付与だけで、子が API から 200 で読める**
// ---------------------------------------------------------------------------

describe("V7-M4-T02 (A): 親に付けた付与だけで子(issue)が見える", () => {
  test("(A-1) 単件 GET が 200 を返す", async () => {
    const response = await get(
      `/api/apps/${APP_ID}/tables/issues/records/${issueA}`,
      inheritor.cookie,
    );
    expect(response.status).toBe(200);
  });

  test("(A-2) 一覧には、その親の子だけが出る(別のプロジェクトの課題は出ない)", async () => {
    const ids = await listIds("issues", inheritor.cookie);
    expect(ids.sort()).toEqual([issueA, issueB].sort());
    expect(ids).not.toContain(otherIssue);
  });
});

// ---------------------------------------------------------------------------
// (B) 完了条件2 —— **3段(親 → 子 → 孫)**
// ---------------------------------------------------------------------------

describe("V7-M4-T02 (B): 親に付けた付与だけで孫(コメント)が見える", () => {
  test("(B-1) 単件 GET が 200 を返す(3段)", async () => {
    const response = await get(
      `/api/apps/${APP_ID}/tables/comments/records/${commentA}`,
      inheritor.cookie,
    );
    expect(response.status).toBe(200);
  });

  test("(B-2) 一覧には、その親の孫だけが出る", async () => {
    const ids = await listIds("comments", inheritor.cookie);
    expect(ids).toEqual([commentA]);
    expect(ids).not.toContain(otherComment);
  });
});

// ---------------------------------------------------------------------------
// (C) 完了条件3 —— **親に付与が無ければ、子も孫も見えない**
// ---------------------------------------------------------------------------

describe("V7-M4-T02 (C): 親に付与が無ければ、子も孫も届かない", () => {
  test("(C-1) 付与を1件も持たない人には、子の単件 GET が 404", async () => {
    const response = await get(`/api/apps/${APP_ID}/tables/issues/records/${issueA}`, none.cookie);
    expect(response.status).toBe(404);
  });

  test("(C-2) 付与を1件も持たない人には、孫の単件 GET が 404", async () => {
    const response = await get(
      `/api/apps/${APP_ID}/tables/comments/records/${commentA}`,
      none.cookie,
    );
    expect(response.status).toBe(404);
  });

  test("(C-3) 付与を1件も持たない人の一覧は、子も孫も0件", async () => {
    expect(await listIds("issues", none.cookie)).toEqual([]);
    expect(await listIds("comments", none.cookie)).toEqual([]);
  });

  test("(C-4) 別のプロジェクトの子・孫は、親の付与を持つ人からも 404", async () => {
    expect(
      (await get(`/api/apps/${APP_ID}/tables/issues/records/${otherIssue}`, inheritor.cookie))
        .status,
    ).toBe(404);
    expect(
      (await get(`/api/apps/${APP_ID}/tables/comments/records/${otherComment}`, inheritor.cookie))
        .status,
    ).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// (D) **fail-closed** —— **親の表が `access_control` を宣言していないとき、何も届かない**
// ---------------------------------------------------------------------------

describe("V7-M4-T02 (D): 宣言していない親は、判定に1ミリも寄与しない", () => {
  /*
   * **【なぜこの分岐が要るか。理由を書く】**
   *
   * **`judgeRecordAccess` は宣言していない表に対して `read` / `write` / `delete` の3つとも
   * `true` を返す**(「この判定は何も絞らない」の意味。オプトインの実体)。
   * **引き継ぎの経路でその答えを OR に混ぜると、「宣言していない親を1つ挟むだけで
   * 全員に全権が届く」穴になる。** **したがって引き継ぎでは、宣言していない親を
   * 判定から外す。**
   */
  test("(D-1) 宣言していない親を指す子は、付与を持たない人から 404 のままである", async () => {
    const response = await get(
      `/api/apps/${APP_ID}/tables/open_issues/records/${openIssue}`,
      none.cookie,
    );
    expect(response.status).toBe(404);
  });

  test("(D-2) 宣言していない親を指す子は、別の付与を持つ人からも 404 である", async () => {
    const response = await get(
      `/api/apps/${APP_ID}/tables/open_issues/records/${openIssue}`,
      inheritor.cookie,
    );
    expect(response.status).toBe(404);
  });

  test("(D-3) 一覧にも1件も出ない", async () => {
    expect(await listIds("open_issues", none.cookie)).toEqual([]);
    expect(await listIds("open_issues", inheritor.cookie)).toEqual([]);
  });

  test("(D-4) 述語の側でも、宣言していない親は3つとも false に倒れる", () => {
    const resolution = resolveRecordAccess({
      manifest: manifest(),
      tableId: "open_issues",
      row: { _id: "row-1", open_project: "parent-1" },
      actorId: "user-a",
      readRows: (tableId) => (tableId === "ac_member" ? [{ _id: "m-a", account: "user-a" }] : []),
      readRow: (tableId, recordId) =>
        tableId === "open_projects" && recordId === "parent-1"
          ? { _id: "parent-1", title: "宣言していない親" }
          : undefined,
    });
    expect(resolution).toEqual({
      kind: "verdict",
      verdict: { read: false, write: false, delete: false },
    });
  });
});

// ---------------------------------------------------------------------------
// (E) 完了条件5 —— **親の権限名が「参照のみ」なら、子に届くのは read だけ**
// ---------------------------------------------------------------------------

describe("V7-M4-T02 (E): 届くのは権限名が持つ動詞だけである", () => {
  test("(E-1) 参照のみの人は、子を読めるが書けない(PATCH が 403)", async () => {
    expect(
      (await get(`/api/apps/${APP_ID}/tables/issues/records/${issueA}`, viewer.cookie)).status,
    ).toBe(200);
    const response = await patch(
      `/api/apps/${APP_ID}/tables/issues/records/${issueA}`,
      viewer.cookie,
      { title: "書き換え" },
      versionOf("issues", issueA),
    );
    expect(response.status).toBe(403);
    // **403 の出どころを名指しする** —— **同じ 403 は origin の検査でも返る。**
    // **「判定に届く前に止まった 403」を「権限が無い 403」と読み違えないため。**
    const body = (await response.json()) as { errors?: { message: string }[] };
    expect(body.errors?.[0]?.message).toBe(
      "この行を書き換える権限がありません(読むことはできます)。",
    );
  });

  test("(E-2) 編集できる人は、子を書ける(200)", async () => {
    const response = await patch(
      `/api/apps/${APP_ID}/tables/issues/records/${issueA}`,
      inheritor.cookie,
      { title: "親の付与で書き換えた" },
      versionOf("issues", issueA),
    );
    expect(response.status).toBe(200);
  });

  test("(E-3) 参照のみの人は、孫も読めるが書けない(3段でも動詞が増えない)", async () => {
    expect(
      (await get(`/api/apps/${APP_ID}/tables/comments/records/${commentA}`, viewer.cookie)).status,
    ).toBe(200);
    const response = await patch(
      `/api/apps/${APP_ID}/tables/comments/records/${commentA}`,
      viewer.cookie,
      { body: "書き換え" },
      versionOf("comments", commentA),
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { errors?: { message: string }[] };
    expect(body.errors?.[0]?.message).toBe(
      "この行を書き換える権限がありません(読むことはできます)。",
    );
  });
});

// ---------------------------------------------------------------------------
// (F) 完了条件6 —— **`inherit_from` が空の表では、今日と1バイトも挙動が変わらない**
// ---------------------------------------------------------------------------

describe("V7-M4-T02 (F): `inherit_from` を宣言していない表は着手前と同じ", () => {
  test("(F-1) 参照を持っていても、`inherit_from` が無ければ親の付与は届かない", async () => {
    const response = await get(
      `/api/apps/${APP_ID}/tables/solo_issues/records/${soloIssue}`,
      inheritor.cookie,
    );
    expect(response.status).toBe(404);
    expect(await listIds("solo_issues", inheritor.cookie)).toEqual([]);
  });

  test("(F-2) 直接の付与は今日どおり効く(全部拒否になっていない)", async () => {
    addGrant({ solo: soloIssue, member: directMember, permission: "writer" });
    expect(
      (await get(`/api/apps/${APP_ID}/tables/solo_issues/records/${soloIssue}`, direct.cookie))
        .status,
    ).toBe(200);
  });

  test("(F-3) いちばん上の親(`inherit_from` を持たない表)も今日どおりである", async () => {
    expect(await listIds("projects", inheritor.cookie)).toEqual([projectId]);
    expect(await listIds("projects", none.cookie)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (G) 完了条件7 —— **辿った先の行を1件も返していない**
// ---------------------------------------------------------------------------

describe("V7-M4-T02 (G): `related` が返す行集合が1件も変わらない", () => {
  test("(G-1) 引き継ぎで見えている人の `related` は、子の行だけを返す", async () => {
    const ids = await relatedIds(projectId, inheritor.cookie);
    expect(ids.sort()).toEqual([issueA, issueB].sort());
    // **辿った先(親・祖父)の行が1件も混ざっていない。**
    for (const traversed of [projectId, otherProjectId, commentA, otherComment]) {
      expect(ids).not.toContain(traversed);
    }
  });

  test("(G-2) 直接の付与で見えている人と、引き継ぎで見えている人の `related` が1件も違わない", async () => {
    const byInheritance = await relatedIds(projectId, inheritor.cookie);
    const byDirectGrant = await relatedIds(projectId, direct.cookie);
    expect(byInheritance.length).toBe(byDirectGrant.length);
    expect([...byInheritance].sort()).toEqual([...byDirectGrant].sort());
  });

  test("(G-3) 引き継ぎを効かせても `related` の行集合が動かない(前後で件数も _id も同じ)", async () => {
    // **引き継ぎが効いていない状態**(`direct` は親への付与を1件も持たない)。
    const before = await relatedIds(projectId, direct.cookie);
    // **同じ人に親への付与を1件足す** —— **引き継ぎがここで効きはじめる。**
    addGrant({ project: projectId, member: directMember, permission: "writer" });
    const after = await relatedIds(projectId, direct.cookie);
    expect(after.length).toBe(before.length);
    expect([...after].sort()).toEqual([...before].sort());
  });
});

// ---------------------------------------------------------------------------
// (H) 述語そのもの —— **訪問済み集合と、辿る枝の飛ばし方**
// ---------------------------------------------------------------------------

describe("V7-M4-T02 (H): `resolveRecordAccess` の形", () => {
  test("(H-1) 親を指していない行では、親の枝を黙って飛ばして判定が続く", () => {
    const resolution = resolveRecordAccess({
      manifest: manifest(),
      tableId: "issues",
      row: { _id: "issue-1" }, // **`project` が空である。**
      actorId: "user-a",
      readRows: (tableId) => {
        if (tableId === "ac_member") {
          return [{ _id: "m-a", account: "user-a" }];
        }
        if (tableId === "ac_grant") {
          return [{ _id: "g-1", issue: "issue-1", member: "m-a", permission: "reader" }];
        }
        return [];
      },
      readRow: () => undefined,
    });
    expect(resolution).toEqual({
      kind: "verdict",
      verdict: { read: true, write: false, delete: false },
    });
  });

  test("(H-2) 親の行が読めないときも、判定は正常に続く(自分の付与は残る)", () => {
    const resolution = resolveRecordAccess({
      manifest: manifest(),
      tableId: "issues",
      row: { _id: "issue-1", project: "消えた親" },
      actorId: "user-a",
      readRows: (tableId) => {
        if (tableId === "ac_member") {
          return [{ _id: "m-a", account: "user-a" }];
        }
        if (tableId === "ac_grant") {
          return [{ _id: "g-1", issue: "issue-1", member: "m-a", permission: "writer" }];
        }
        return [];
      },
      readRow: () => undefined,
    });
    expect(resolution).toEqual({
      kind: "verdict",
      verdict: { read: true, write: true, delete: false },
    });
  });

  test("(H-3) 同じ (表, 行) を2度訪れない —— 自分自身を親に持つ行でも応答が返る", () => {
    // **`V7-M4-T03` が専用の検査を別に置く。** **ここで測るのは「戻ってくること」だけである。**
    const selfParent = manifest() as unknown as {
      app: { tables: { id: string; fields: Record<string, unknown>[] }[] };
    };
    const issues = selfParent.app.tables.find((table) => table.id === "issues") as {
      fields: Record<string, unknown>[];
    };
    issues.fields.push({
      id: "self",
      name: "自分",
      type: "reference",
      reference_table: "issues",
    });
    (
      (
        selfParent.app.tables.find((table) => table.id === "issues") as unknown as {
          access_control: Record<string, unknown>;
        }
      ).access_control as Record<string, unknown>
    ).inherit_from = ["self"];
    const row = { _id: "issue-1", self: "issue-1" };
    const resolution = resolveRecordAccess({
      manifest: selfParent as unknown as Manifest,
      tableId: "issues",
      row,
      actorId: "user-a",
      readRows: (tableId) => (tableId === "ac_member" ? [{ _id: "m-a", account: "user-a" }] : []),
      readRow: () => row,
    });
    expect(resolution.kind).toBe("verdict");
  });

  test("(H-4) 宣言していない表は今日どおり3つとも true(オプトインを壊していない)", () => {
    const resolution = resolveRecordAccess({
      manifest: manifest(),
      tableId: "open_projects",
      row: { _id: "p-1" },
      actorId: null,
      readRows: () => [],
      readRow: () => undefined,
    });
    expect(resolution).toEqual({
      kind: "verdict",
      verdict: { read: true, write: true, delete: true },
    });
  });
});
