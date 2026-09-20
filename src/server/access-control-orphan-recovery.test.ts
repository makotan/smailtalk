/**
 * **`V17-M6-T01`(`AC-G22`)**: **親を消したあとに残る行を、運営が回復できるようにする。**
 *
 * ## **本ファイルが撃つもの(計画 `docs/plan/v17/07-v17-m6-plan.md` §2b の 1 の6項)**
 *
 *  1. **親を消す前は `unreachable-records` が空である**(**着手前から緑**)。
 *  2. **親を消した直後は子の行が並ぶ**(**着手前から緑**)。
 *  3. **運営(`owner`)が並んだ行への付与を `POST` すると **201****(**着手前は 403 で赤**)。
 *  4. **作った付与の相手は、その子の行を単票 `GET` で **200** で読める**(**着手前は赤**)。
 *  5. **非運営は今日どおり通らない**(**着手前から緑。1ミリも緩めない**)。
 *  6. **親が**生きている**ときの拒否は今日どおりである**(**着手前から緑。1ミリも緩めない**)。
 *
 * ## **【誇張しない。この口が「安全になった」わけではない】**
 *
 * - **見つける側(`unreachable-records`)は着手前から動いている** —— **本タスクは母集団を
 *   1バイトも動かしていない**(項1 / 項2 は**回帰の歯止め**であって成果ではない)。
 * - **通すのは「親の行が読めない」ときだけである。** **`readRow` は「消えている」と
 *   「読めない」を1つの `undefined` でしか返さないので、本実装はこの2つを区別していない。**
 * - **行の作成者には広げていない**(項5 の後半が実測で固定する)。
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
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "orphan-recovery";

const PERMISSIONS = [
  { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
  { id: "writer", name: "編集できる", read: true, write: true, delete: false },
  { id: "keeper", name: "作った人", read: true, write: true, delete: true },
] as const;

/** 運営専用の口。**`/records` の下ではなく兄弟のパスに置いてある。** */
const DOOR = (tableId: string): string =>
  `/api/apps/${APP_ID}/tables/${tableId}/unreachable-records`;

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "親を消したあとの回復",
      tables: [
        {
          id: "projects",
          name: "プロジェクト",
          fields: [{ id: "title", name: "名前", type: "text", required: true }],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "keeper",
            // **【`V18-M5-T02b` / `PM-G2` / `ADR-0442`】題材に1行足した(主張は1バイトも
            // 書き換えていない)。** **根の表に「行を作れる立場」を一行も書かないときの
            // 既定が「誰も作れない」へ反転したので**(`ADR-0432` §Decision)、
            // **前準備の `POST /tables/projects/records`(`editor` の `boss`)が 403 に
            // なり、7本が巻き込まれていた。** **子の `issues` は `inherit_from` を
            // 宣言しているので根の表ではなく、1行も足していない。**
            creatable_by_roles: ["editor"],
            grant: {
              table: "project_grant",
              target: "project",
              member: "member",
              group: "team",
              permission: "permission",
            },
            members: { table: "app_member", account: "account", group: "team" },
            groups: { table: "app_team" },
          },
        },
        {
          id: "issues",
          name: "課題",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "project", name: "プロジェクト", type: "reference", reference_table: "projects" },
          ],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "keeper",
            inherit_from: ["project"],
            grant: {
              table: "issue_grant",
              target: "issue",
              member: "member",
              group: "team",
              permission: "permission",
            },
            members: { table: "app_member", account: "account", group: "team" },
            groups: { table: "app_team" },
          },
        },
        { id: "app_team", name: "班", fields: [{ id: "title", name: "名前", type: "text" }] },
        {
          id: "app_member",
          name: "利用者",
          fields: [
            { id: "account", name: "ログイン", type: "text" },
            { id: "team", name: "班", type: "reference", reference_table: "app_team" },
          ],
        },
        {
          id: "project_grant",
          name: "プロジェクトの付与",
          fields: [
            { id: "project", name: "対象", type: "reference", reference_table: "projects" },
            { id: "member", name: "相手", type: "reference", reference_table: "app_member" },
            { id: "team", name: "班", type: "reference", reference_table: "app_team" },
            {
              id: "permission",
              name: "権限",
              type: "select",
              options: ["reader", "writer", "keeper"],
            },
          ],
        },
        {
          id: "issue_grant",
          name: "課題の付与",
          fields: [
            { id: "issue", name: "対象", type: "reference", reference_table: "issues" },
            { id: "member", name: "相手", type: "reference", reference_table: "app_member" },
            { id: "team", name: "班", type: "reference", reference_table: "app_team" },
            {
              id: "permission",
              name: "権限",
              type: "select",
              options: ["reader", "writer", "keeper"],
            },
          ],
        },
      ],
      views: [],
      workflows: [],
    },
  } as unknown as Manifest;
}

let dataRoot = "";
let app: ReturnType<typeof createServerApp>;
let boss: ReturnType<typeof seedSession>;
let admin: ReturnType<typeof seedSession>;
let assignee: ReturnType<typeof seedSession>;
let outsider: ReturnType<typeof seedSession>;
let assigneeMember = "";
let outsiderMember = "";
let projectId = "";
/** **付与を1件も持たない子の行**(取り残しになるのはこちら)。 */
let orphanIssueId = "";
/** **作成者(`boss`)への付与を1件持つ子の行**(項5 の前半で使う)。 */
let ownedIssueId = "";

async function post(path: string, cookie: string, body: unknown): Promise<Response> {
  return await app.request(path, {
    method: "POST",
    headers: { cookie, origin: TEST_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function get(path: string, cookie: string): Promise<Response> {
  return await app.request(path, { method: "GET", headers: { cookie } });
}

async function remove(path: string, cookie: string, ifMatch: string): Promise<Response> {
  return await app.request(path, {
    method: "DELETE",
    headers: { cookie, origin: TEST_ORIGIN, "if-match": ifMatch },
  });
}

/**
 * **親(`projects`)の行を消して、子を取り残しにする。**
 *
 * **【`V18-M7-T02`(台帳 `PM-G5` / `ADR-0444` 授権の表 行8)による更新。旧の式を1バイトも
 * 消していない】**
 *
 * **旧(逐語)**:
 * ```
 * const removed = await remove(`/api/apps/${APP_ID}/tables/projects/records/${projectId}`,
 *   boss.cookie, etag);
 * expect(removed.status).toBe(204);
 * ```
 *
 * **理由は「実物が変わった」側である** —— **`V18-M7` が `DELETE` に、ぶら下がっている行の
 * 連鎖の関門を1本足した。** **子が居る親の `DELETE` は、件数の印(`If-Match-Children`)が
 * 無ければ **409** で断られ、印を付ければ**子も一緒に消える**** —— **どちらの道でも、
 * **HTTP 経由ではもう「親だけ消えて子が残る」状態を作れない**。**
 *
 * **【この検査が測っているものは1ミリも変えていない】** —— **(O-2) 〜 (O-5b) が測るのは
 * 「**取り残しになった行**を運営が回復できるか」であり、その状態の**作り方**は主題ではない。**
 * **本関数は、今日もその状態を作れる経路 —— 受信口 / 自動処理 / コードの島 / 決まった時刻に
 * 動く処理(`ADR-0444` 限定8。いずれもこの関門が1バイトも掛からない)—— と同じ結果になる
 * ように、DB の行を直に消す。**
 *
 * **【むしろ1本強くしている】** —— **先に HTTP を撃って **409** を実測で押さえてから消す。**
 */
async function deleteParent(): Promise<void> {
  const single = await get(`/api/apps/${APP_ID}/tables/projects/records/${projectId}`, boss.cookie);
  expect(single.status).toBe(200);
  const etag = single.headers.get("etag") ?? "";
  const refused = await remove(
    `/api/apps/${APP_ID}/tables/projects/records/${projectId}`,
    boss.cookie,
    etag,
  );
  // **子が2件ぶら下がっているので、件数の印の無い `DELETE` は今日 409 である。**
  // **文面まで見る** —— **版不一致や適用中の 409 と取り違えないため。**
  const body = (await refused.json()) as { errors?: { hint?: string }[] };
  expect({
    status: refused.status,
    seal: (body.errors?.[0]?.hint ?? "").includes("If-Match-Children"),
  }).toEqual({ status: 409, seal: true });
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    db.query(`DELETE FROM projects WHERE _id = ?`).run(projectId);
    // **子は1行も消えていない** —— **取り残しが実際に出来ていることを、ここで押さえる。**
    expect((db.query(`SELECT COUNT(*) AS n FROM issues`).get() as { n: number }).n).toBe(2);
  } finally {
    db.close();
  }
}

async function doorTotal(tableId: string): Promise<number> {
  const response = await get(DOOR(tableId), admin.cookie);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { total: number };
  return body.total;
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-orphan-recovery-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "親を消したあとの回復", { app_id: APP_ID });
  } finally {
    store.close();
  }
  // **保護対象の `projects` / `issues` には面の規則を1本も足さない** ——
  // **面を開けると点の測定が無効になる**(面と点は OR)。
  expect(
    applyManifest(
      dataRoot,
      APP_ID,
      withDefaultRoleRules(manifest(), { skipTables: ["projects", "issues"] }),
    ).valid,
  ).toBe(true);
  app = createServerApp({ dataRoot });
  boss = seedSession(dataRoot, APP_ID, { role: "editor", username: "boss" });
  admin = seedSession(dataRoot, APP_ID, { role: "owner", username: "admin" });
  assignee = seedSession(dataRoot, APP_ID, { role: "editor", username: "assignee" });
  outsider = seedSession(dataRoot, APP_ID, { role: "editor", username: "outsider" });

  const loaded = manifest();
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    const member = (account: string): string => {
      const created = createRecord(db, loaded, "app_member", { account });
      expect(created.ok).toBe(true);
      return (created as { value: { _id: string } }).value._id;
    };
    member(boss.userId);
    member(admin.userId);
    assigneeMember = member(assignee.userId);
    outsiderMember = member(outsider.userId);
  } finally {
    db.close();
  }

  // **親は HTTP で作る** —— **`boss` に `keeper` が1件入り、`boss` が消せるようになる。**
  const project = await post(`/api/apps/${APP_ID}/tables/projects/records`, boss.cookie, {
    title: "第1案件",
  });
  expect(project.status).toBe(201);
  projectId = ((await project.json()) as { record: { _id: string } }).record._id;

  // **取り残しになる子の行は、付与が1件も入らない経路で作る** ——
  // **HTTP で作ると作成者への付与が1件入り、`unreachable-records` の母集団に並ばない。**
  const db2 = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    const created = createRecord(db2, loaded, "issues", {
      title: "取り残される課題",
      project: projectId,
    });
    expect(created.ok).toBe(true);
    orphanIssueId = (created as { value: { _id: string } }).value._id;
  } finally {
    db2.close();
  }

  // **作成者への付与を持つ子の行**(項5 の前半)。
  const owned = await post(`/api/apps/${APP_ID}/tables/issues/records`, boss.cookie, {
    title: "作成者のいる課題",
    project: projectId,
  });
  expect(owned.status).toBe(201);
  ownedIssueId = ((await owned.json()) as { record: { _id: string } }).record._id;
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

describe("V17-M6-T01 (O): 親を消したあとに残る行を、運営が回復できる", () => {
  test("(O-1) 親を消す前は、取り残しの口に1行も並ばない", async () => {
    expect({ issues: await doorTotal("issues"), projects: await doorTotal("projects") }).toEqual({
      issues: 0,
      projects: 0,
    });
  });

  test("(O-2) 親を消した直後は、付与を持たない子の行が取り残しの口に並ぶ", async () => {
    await deleteParent();
    const response = await get(DOOR("issues"), admin.cookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { total: number; records: { _id: string }[] };
    expect({ total: body.total, ids: body.records.map((row) => row._id) }).toEqual({
      total: 1,
      ids: [orphanIssueId],
    });
  });

  test("(O-3) 親が消えた行に、運営(owner)が付与を1件作れる(201)", async () => {
    await deleteParent();
    const response = await post(`/api/apps/${APP_ID}/tables/issue_grant/records`, admin.cookie, {
      issue: orphanIssueId,
      member: assigneeMember,
      permission: "reader",
    });
    expect(response.status).toBe(201);
  });

  test("(O-4) 運営が作った付与の相手は、その子の行を単票で読める(200)", async () => {
    await deleteParent();
    const before = await get(
      `/api/apps/${APP_ID}/tables/issues/records/${orphanIssueId}`,
      assignee.cookie,
    );
    const created = await post(`/api/apps/${APP_ID}/tables/issue_grant/records`, admin.cookie, {
      issue: orphanIssueId,
      member: assigneeMember,
      permission: "reader",
    });
    expect(created.status).toBe(201);
    const after = await get(
      `/api/apps/${APP_ID}/tables/issues/records/${orphanIssueId}`,
      assignee.cookie,
    );
    expect({ before: before.status, after: after.status }).toEqual({ before: 404, after: 200 });
  });

  test("(O-5) 非運営は、親が消えていても付与を作れない(作成者は 403 のまま)", async () => {
    await deleteParent();
    // **`boss` は `ownedIssueId` の作成者である**(`creator_permission` を直接持つ)。
    // **関門 (2) は通るが、親が消えているので今日どおり止まる。**
    const asCreator = await post(`/api/apps/${APP_ID}/tables/issue_grant/records`, boss.cookie, {
      issue: ownedIssueId,
      member: assigneeMember,
      permission: "reader",
    });
    expect(asCreator.status).toBe(403);
    const body = (await asCreator.json()) as { errors: { message: string }[] };
    expect(body.errors[0]?.message).toBe(
      "この相手は、元になっている行を見る権限を持っていないため、ここには追加できません。",
    );
  });

  test("(O-5b) 【実測】作成者でもない非運営は、今日も 404 である(403 ではない)", async () => {
    await deleteParent();
    const response = await post(`/api/apps/${APP_ID}/tables/issue_grant/records`, outsider.cookie, {
      issue: orphanIssueId,
      member: outsiderMember,
      permission: "reader",
    });
    expect(response.status).toBe(404);
  });

  test("(O-6) 親が生きているときの拒否は今日どおりである(運営でも止まる)", async () => {
    const response = await post(`/api/apps/${APP_ID}/tables/issue_grant/records`, admin.cookie, {
      issue: ownedIssueId,
      member: assigneeMember,
      permission: "reader",
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { errors: { message: string }[] };
    expect(body.errors[0]?.message).toBe(
      "この相手は、元になっている行を見る権限を持っていないため、ここには追加できません。",
    );
  });
});
