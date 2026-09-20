/**
 * **`V14-M1-T01` / `V14-M1-T02` / `V14-M1-T03`(台帳 `RB-G1` / `RB-G2` / `RB-G3`)**:
 * **サーバが「その行に何ができるか」を応答に載せる。**
 *
 * ## 測るもの
 *
 * - **(A)** **一覧 `GET`**: **`access_control` を宣言した表のときだけ** `access` が載り、
 *   **返した行ぶんちょうど**のキーを持ち、**値のキーは4つちょうど**
 *   (`read` / `write` / `delete` / `grant_write`)である。**`blockedBy` は載せない。**
 * - **(B)** **宣言していない表**(`plain`)と**面の条件だけが立っている表**(`memos` =
 *   母集団の `role_conditional` 枝)では、**`access` キーが存在しない。**
 * - **(C)** **単票 `GET`**: **`{ record, access }` になる**(既存キー `record` の形を
 *   1バイトも変えない)。**宣言していない表では載せない。**
 * - **(D)** **`grant_write`**: **関門 (1)(2) だけを答える。**
 *   **`creator_permission` を直接持つ人と運営ロールにだけ真になり、
 *   `write` とは別物である**(`write: false` でも真になりうる)。
 * - **(E)** **`grant_write: true` は「押せば必ず作れる」の保証ではない** ——
 *   **関門 (3)(自分自身)で実際に 403 になる行を、同じ実測の中で並べて示す。**
 *
 * ## **【2026-09-08 追記(`V17-M6-T05` / `AC-G30b`)。上の行を1バイトも消していない】**
 *
 * - **(F)** **`grant_write` が引き継ぎ(`inherit_from`)を辿る** —— **親の側でだけ
 *   `creator_permission` と同じ綴りの権限を持つ人にも、`grant_write` が真になる。**
 *   **`creator_permission` 以外の権限しか持たない人は偽のままである**(緩めていない)。
 * - **(F-5)** **真になったその行に、その人が実際に付与を `POST` したときの応答コードを
 *   固定する** —— **`judgeGrantWrite` の側は今日も辿らないので、表示と実際は食い違う。**
 *   **【禁止】この食い違いを「一致した」と書かない。**
 *
 * ## **【2026-09-14 追記(`V18-M8-T02` / `ADR-0445`)。上の行を1バイトも消していない】**
 *
 * - **上の (D) の「関門 (1)(2) だけを答える」、(F) の「引き継ぎを辿る」、(F-5) の
 *   「表示と実際は食い違う」は今日の正ではない。** **表示は壁の述語 `judgeGrantWrite` を
 *   呼んで関門 (1)(2) を取り(引き継ぎを辿らない)、そのうえで「表示の時点で決まる断り」
 *   (付与表への面の書込 / 直接作成の遮断 / ボタンの規則 / 必ず送る欄の項目規則 /
 *   付与表そのものの宣言が掛ける関門)を写す。**
 * - **(F-5) は同じ1本の式で「食い違いが無い」を撃つ形に変えた。**
 * - **(G)** **場面を1本ずつ撃つ** —— **偽の組は `POST` の `message` の逐語で止めた層を示し、
 *   真の組は「相手を自分にした `POST` が関門 (3) の文面で止まる」ことで示す**
 *   (**`201` を期待値に書かない**。`ADR-0436` 追記4)。
 * - **【誇張しない】相手を選んでから決まる断り(自分自身へ / 解決できない相手 / 親を読めない相手)
 *   と、条件つきの規則・必須でない欄の項目規則は写していない** —— **(G-11)(G-13)(G-14) が
 *   「配れると出て押すと断られる」形が残ることを撃つ。**
 *
 * ## 測らないもの(**誇張しない**)
 *
 * - **画面(`web/`)は1バイトも触っていない** —— **ボタンの出し分けは `V14-M2` の担当である。**
 * - **サーバの遮断(403 / 404)を1ミリも動かしていない** —— **本ファイルは「応答に載る
 *   判定」だけを測る。**
 * - **母集団の `owner_scoped` 枝 / `anonymous_public` 枝には載せていない**
 *   (`record_access` 枝ちょうど1本である)。**(B-3) がそれを実測で固定する。**
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
import { judgeGrantWrite, OWNER_FIELD, rowGrantWriteJudge } from "./owner-scope.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "row-access-buttons";

const PERMISSIONS = [
  { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
  { id: "writer", name: "編集できる", read: true, write: true, delete: false },
] as const;

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "案件台帳",
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
          ],
        },
        { id: "editor", name: "編集者" },
        {
          id: "viewer",
          name: "閲覧者",
          // **面の条件だけが立っている表**(母集団の `role_conditional` 枝)。
          rules: [
            {
              target: "table",
              table: "memos",
              can: ["read"],
              when: { field: "open", equals: true },
            },
            // **【2026-09-14 `V18-M8-T02`(`ADR-0445`)】閲覧者に付与表3本への書込を足した(台の前提)。**
            // **表示の `grant_write` が面(付与表への書込)を見るようになったので、足さないと
            // 「配れる人」を撃つ検査((A-3)(B-3)(C-1)(E-1)(F-3))の主題が面の断りにすり替わる。**
            // **これらの検査の主題は面ではない**(計画 §6 の作法: 期待値より先に台を直す)。
            // **面で付与表に書けない人は `(G-2)` が別の台で撃つ。**
            { target: "table", table: "case_grant", can: ["read", "write"] },
            { target: "table", table: "owned_grant", can: ["read", "write"] },
            { target: "table", table: "task_grant", can: ["read", "write"] },
          ],
        },
      ],
      tables: [
        {
          id: "cases",
          name: "案件",
          fields: [{ id: "title", name: "題", type: "text", required: true }],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "writer",
            grant: {
              table: "case_grant",
              target: "case",
              member: "member",
              permission: "permission",
            },
            members: { table: "case_member", account: "account" },
          },
        },
        {
          id: "plain",
          name: "掲示",
          fields: [{ id: "body", name: "本文", type: "text" }],
        },
        {
          // **`st_owner` は在るが `access_control` を宣言していない表**(`(B-4)` が使う)。
          // **`owner_scoped` 枝に入るが、点は管轄外である。**
          id: "plain_owned",
          name: "個人所有だが宣言なし",
          fields: [
            { id: "title", name: "題", type: "text", required: true },
            { id: OWNER_FIELD, name: "所有者", type: "text" },
          ],
        },
        {
          id: "memos",
          name: "覚書",
          fields: [
            { id: "body", name: "本文", type: "text" },
            { id: "open", name: "公開", type: "boolean" },
          ],
        },
        {
          id: "owned",
          name: "個人所有かつ宣言つき",
          fields: [
            { id: "title", name: "題", type: "text", required: true },
            { id: OWNER_FIELD, name: "所有者", type: "text" },
          ],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "writer",
            grant: {
              table: "owned_grant",
              target: "owned",
              member: "member",
              permission: "permission",
            },
            members: { table: "case_member", account: "account" },
          },
        },
        {
          id: "owned_grant",
          name: "個人所有の付与",
          fields: [
            { id: "owned", name: "行", type: "reference", reference_table: "owned" },
            { id: "member", name: "相手", type: "reference", reference_table: "case_member" },
            { id: "permission", name: "権限", type: "select", options: ["reader", "writer"] },
          ],
        },
        {
          id: "case_member",
          name: "利用者",
          fields: [{ id: "account", name: "ログイン", type: "text" }],
        },
        {
          id: "case_grant",
          name: "付与",
          fields: [
            { id: "case", name: "案件", type: "reference", reference_table: "cases" },
            { id: "member", name: "相手", type: "reference", reference_table: "case_member" },
            { id: "permission", name: "権限", type: "select", options: ["reader", "writer"] },
          ],
        },
        {
          // **【2026-09-08 追記(`V17-M6-T05` / `AC-G30b`)】親から引き継ぐ子の表。**
          // **`inherit_from` に `case` を書いてあるので、`cases` の側の付与だけを持つ人にも
          // この表の行が届く。** **`creator_permission` は親と同じ綴り(`writer`)である** ——
          // **親の付与表 `case_grant` が配る `writer` が、この表の「作成者相当」に一致する。**
          id: "tasks",
          name: "作業",
          fields: [
            { id: "title", name: "題", type: "text", required: true },
            { id: "case", name: "案件", type: "reference", reference_table: "cases" },
          ],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "writer",
            inherit_from: ["case"],
            grant: {
              table: "task_grant",
              target: "task",
              member: "member",
              permission: "permission",
            },
            members: { table: "case_member", account: "account" },
          },
        },
        {
          id: "task_grant",
          name: "作業の付与",
          fields: [
            { id: "task", name: "作業", type: "reference", reference_table: "tasks" },
            { id: "member", name: "相手", type: "reference", reference_table: "case_member" },
            { id: "permission", name: "権限", type: "select", options: ["reader", "writer"] },
          ],
        },
      ],
      views: [],
    },
  } as unknown as Manifest;
}

const SIGNED_IN = ["owner", "editor", "viewer"] as const;
type SignedIn = (typeof SIGNED_IN)[number];

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;
let actors: Record<SignedIn, ReturnType<typeof seedSession>>;
let members: Record<SignedIn, string>;
/** `viewer` に `writer` を付与した行 / `reader` を付与した行 / 付与0件の行。 */
let rowWriter = "";
let rowReader = "";
let rowNone = "";
let plainRow = "";
let memoOpen = "";
let ownedRow = "";
let plainOwnedRow = "";
/** **【`V17-M6-T05` / `AC-G30b`】** 引き継ぎだけで届く子の行 / 直接の付与を持つ子の行 / 親に `reader` しか持たない子の行。 */
let taskInherited = "";
let taskDirect = "";
let taskReaderOnly = "";

function withDb<T>(run: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

async function body(path: string, cookie: string): Promise<Record<string, unknown>> {
  const response = await app.request(path, { headers: { cookie } });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-rowaccess-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "案件台帳", { app_id: APP_ID });
  } finally {
    store.close();
  }
  // **面と点は `OR` なので、宣言つきの2表には面の規則を1本も足さない**
  // (足すと点の測定が丸ごと無効になる)。**`memos` も足さない** ——
  // **条件つきの規則だけを立てて `role_conditional` 枝へ落とすためである。**
  expect(
    applyManifest(
      dataRoot,
      APP_ID,
      withDefaultRoleRules(manifest(), { skipTables: ["cases", "owned", "memos", "tasks"] }),
    ).valid,
  ).toBe(true);
  app = createServerApp({ dataRoot });

  actors = {} as Record<SignedIn, ReturnType<typeof seedSession>>;
  for (const role of SIGNED_IN) {
    actors[role] = seedSession(dataRoot, APP_ID, { role, username: `u-${role}` });
  }

  const loaded = manifest();
  members = {} as Record<SignedIn, string>;
  withDb((db) => {
    const insert = (table: string, values: Record<string, unknown>): string => {
      const created = createRecord(db, loaded, table, values);
      expect(created.ok).toBe(true);
      return (created as { value: { _id: string } }).value._id;
    };
    rowWriter = insert("cases", { title: "編集できる案件" });
    rowReader = insert("cases", { title: "参照だけの案件" });
    rowNone = insert("cases", { title: "付与0件の案件" });
    plainRow = insert("plain", { body: "宣言していない表" });
    memoOpen = insert("memos", { body: "公開の覚書", open: true });
    insert("memos", { body: "非公開の覚書", open: false });
    for (const role of SIGNED_IN) {
      members[role] = insert("case_member", { account: actors[role].userId });
    }
    insert("case_grant", { case: rowWriter, member: members.viewer, permission: "writer" });
    insert("case_grant", { case: rowReader, member: members.viewer, permission: "reader" });
    // **運営(`owner`)にも1件だけ付与して、行が見えるようにする**
    // (面の規則を1本も書いていないので、付与が無いと 0 件になる)。
    insert("case_grant", { case: rowReader, member: members.owner, permission: "reader" });
    // **【2026-09-08 追記(`V17-M6-T05` / `AC-G30b`)】3本の子の行を作る。**
    //  - `taskInherited` … 親(`rowWriter`)に `viewer` が `writer` を持つ。**子には直接の付与が0件**。
    //  - `taskDirect`    … 親(`rowNone`)に `viewer` は付与を1件も持たない。**子に直接 `writer`**。
    //  - `taskReaderOnly`… 親(`rowReader`)に `viewer` は `reader` しか持たない。
    taskInherited = insert("tasks", { title: "引き継ぎだけの作業", case: rowWriter });
    taskDirect = insert("tasks", { title: "直接の付与がある作業", case: rowNone });
    taskReaderOnly = insert("tasks", { title: "参照だけの親の作業", case: rowReader });
    insert("task_grant", { task: taskDirect, member: members.viewer, permission: "writer" });
    // **`editor` にも親(`rowWriter`)の `writer` を1件配る** —— **`(F-5)` が
    // `judgeGrantWrite` まで届く名乗りを要るためである**(既定の規則では `viewer` は
    // 表への書込を1つも持たず、面の層が先に 403 で止めて判定まで届かない。
    // 計画 §1-2 の 1 が「実地では届かなかった」と書いたのと同じ壁である)。
    insert("case_grant", { case: rowWriter, member: members.editor, permission: "writer" });
    ownedRow = insert("owned", { title: "自分の行", [OWNER_FIELD]: actors.viewer.userId });
    insert("owned_grant", { owned: ownedRow, member: members.viewer, permission: "writer" });
    plainOwnedRow = insert("plain_owned", {
      title: "宣言なしの自分の行",
      [OWNER_FIELD]: actors.viewer.userId,
    });
  });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (A) 一覧 GET —— 宣言した表にだけ `access` が載る
// ---------------------------------------------------------------------------

describe("V14-M1-T01 (A): 一覧 GET が行ごとの判定を載せる", () => {
  test("(A-1) 宣言した表の応答に `access` が在り、返した行ぶんちょうどのキーを持つ", async () => {
    const json = await body(`/api/apps/${APP_ID}/tables/cases/records`, actors.viewer.cookie);
    const records = json.records as { _id: string }[];
    expect(records.map((row) => row._id).sort()).toEqual([rowReader, rowWriter].sort());
    const access = json.access as Record<string, unknown>;
    expect(Object.keys(access).sort()).toEqual([rowReader, rowWriter].sort());
  });

  test("(A-2) 値のキーは4つちょうどで、`blockedBy` を1件も載せていない", async () => {
    const json = await body(`/api/apps/${APP_ID}/tables/cases/records`, actors.viewer.cookie);
    const access = json.access as Record<string, Record<string, unknown>>;
    for (const entry of Object.values(access)) {
      expect(Object.keys(entry).sort()).toEqual(["delete", "grant_write", "read", "write"]);
    }
    expect(JSON.stringify(json).includes("blockedBy")).toBe(false);
  });

  test("(A-3) 動詞の値が付与のとおりである(`writer` は書ける・`reader` は書けない)", async () => {
    const json = await body(`/api/apps/${APP_ID}/tables/cases/records`, actors.viewer.cookie);
    const access = json.access as Record<string, Record<string, boolean>>;
    expect(access[rowWriter]).toEqual({
      read: true,
      write: true,
      delete: false,
      grant_write: true,
    });
    expect(access[rowReader]).toEqual({
      read: true,
      write: false,
      delete: false,
      grant_write: false,
    });
  });

  test("(A-4) 返らなかった行(付与0件)は `access` にも1件も現れない", async () => {
    const json = await body(`/api/apps/${APP_ID}/tables/cases/records`, actors.viewer.cookie);
    expect(Object.keys(json.access as Record<string, unknown>)).not.toContain(rowNone);
  });

  test("(A-5) ページを切った先だけが載る(`limit=1` で `access` も1件)", async () => {
    const json = await body(
      `/api/apps/${APP_ID}/tables/cases/records?limit=1&offset=0`,
      actors.viewer.cookie,
    );
    const records = json.records as { _id: string }[];
    expect(records.length).toBe(1);
    expect(Object.keys(json.access as Record<string, unknown>)).toEqual([
      records[0]?._id as string,
    ]);
  });
});

// ---------------------------------------------------------------------------
// (B) 宣言していない表・`role_conditional` 枝・`owner_scoped` 枝には載せない
// ---------------------------------------------------------------------------

describe("V14-M1-T01 (B): 載せない枝を1件ずつ実測で固定する", () => {
  test("(B-1) 宣言していない表の応答に `access` キーが存在しない", async () => {
    const json = await body(`/api/apps/${APP_ID}/tables/plain/records`, actors.viewer.cookie);
    expect((json.records as { _id: string }[]).map((row) => row._id)).toEqual([plainRow]);
    expect(json).not.toHaveProperty("access");
  });

  test("(B-2) `role_conditional` 枝(面の条件だけが立つ表)にも載せない", async () => {
    const json = await body(`/api/apps/${APP_ID}/tables/memos/records`, actors.viewer.cookie);
    expect((json.records as { _id: string }[]).map((row) => row._id)).toEqual([memoOpen]);
    expect(json).not.toHaveProperty("access");
  });

  test("(B-3) `owner_scoped` 枝(`st_owner` と宣言を併せ持つ表)にも載せる", async () => {
    // **【`V14-M1-T05` で挙動を変えた。旧の姿を逐語で残す】**
    // **`V14-M1-T01` の時点では、この検査は逆を撃っていた**(逐語の見出し =
    // 「`owner_scoped` 枝(`st_owner` と宣言を併せ持つ表)にも**今日は載せていない**」)。
    // **旧のコメントも逐語で残す**: 「**これは穴である** —— **この表は `access_control`
    // を宣言しているのに `access` が載らない。** **`V14-M2` の画面はこの表で今日どおり
    // (= 面だけで)ボタンを出す。** **`V14-M1-T01` の完了条件が「`record_access` 枝に
    // だけ載せる」であるためであり、載せられないからではない**(その枝も判定を全行に
    // 呼んでいる)。」
    // **穴を空けたままにしないと決めたので、撃つ向きを反転させた** ——
    // **空けたままだと、この表で issue が報告したのとまったく同じ
    // 「出るのに押せない」が残る。** **判定を新しく走らせてはいない。**
    const json = await body(`/api/apps/${APP_ID}/tables/owned/records`, actors.viewer.cookie);
    expect((json.records as { _id: string }[]).map((row) => row._id)).toEqual([ownedRow]);
    expect(json.access).toEqual({
      [ownedRow]: { read: true, write: true, delete: false, grant_write: true },
    });
  });

  test("(B-4) `st_owner` は在るが宣言していない表には載せない(`owner_scoped` の残り半分)", async () => {
    // **(B-3) を反転させた以上、`owner_scoped` 枝の「載せない側」を別に撃っておく。**
    // **さもないと「宣言していない表の応答が1バイトも変わっていない」(計画 §7 の条件7)が
    // `owner_scoped` 枝について1本も担保されない** —— **(B-1) が撃っているのは
    // `unfiltered` 枝の表である。**
    const json = await body(`/api/apps/${APP_ID}/tables/plain_owned/records`, actors.viewer.cookie);
    expect((json.records as { _id: string }[]).map((row) => row._id)).toEqual([plainOwnedRow]);
    expect(json).not.toHaveProperty("access");
  });
});

// ---------------------------------------------------------------------------
// (C) 単票 GET
// ---------------------------------------------------------------------------

describe("V14-M1-T02 (C): 単票の口にも同じ形で1つ載せる", () => {
  test("(C-1) 宣言した表では `{ record, access }` になり、既存キー `record` の形が変わらない", async () => {
    const json = await body(
      `/api/apps/${APP_ID}/tables/cases/records/${rowWriter}`,
      actors.viewer.cookie,
    );
    expect(Object.keys(json).sort()).toEqual(["access", "record"]);
    expect((json.record as { _id: string })._id).toBe(rowWriter);
    expect(json.access).toEqual({
      [rowWriter]: { read: true, write: true, delete: false, grant_write: true },
    });
  });

  test("(C-2) 宣言していない表では載せない(`record` の1キーだけ)", async () => {
    const json = await body(
      `/api/apps/${APP_ID}/tables/plain/records/${plainRow}`,
      actors.viewer.cookie,
    );
    expect(Object.keys(json)).toEqual(["record"]);
    expect(json).not.toHaveProperty("access");
  });
});

// ---------------------------------------------------------------------------
// (D) grant_write —— 関門 (1)(2) だけ
// ---------------------------------------------------------------------------

describe("V14-M1-T03 (D): `grant_write` は `write` とは別の問いである", () => {
  test("(D-1) 運営ロールは `write: false` の行でも `grant_write: true` である", async () => {
    const json = await body(`/api/apps/${APP_ID}/tables/cases/records`, actors.owner.cookie);
    const access = json.access as Record<string, Record<string, boolean>>;
    expect(access[rowReader]).toEqual({
      read: true,
      write: false,
      delete: false,
      grant_write: true,
    });
  });

  test("(D-2) 宣言のうち `grant.table` が無い表では `false` を返す(入口の単体)", () => {
    const broken = {
      app: {
        id: APP_ID,
        tables: [
          {
            id: "cases",
            fields: [],
            access_control: {
              enabled: true,
              permissions: [...PERMISSIONS],
              creator_permission: "writer",
              grant: {},
            },
          },
        ],
      },
    } as unknown as Manifest;
    const judge = rowGrantWriteJudge({
      manifest: broken,
      tableId: "cases",
      actorId: "u1",
      roles: "owner",
      readRows: () => [],
    });
    expect(judge({ _id: "r1" })).toBe(false);
  });

  test("(D-3) 行が決まらない(`_id` が無い)ときは `false` である(関門 (1))", () => {
    const judge = rowGrantWriteJudge({
      manifest: manifest(),
      tableId: "cases",
      actorId: "u1",
      roles: "owner",
      readRows: () => [],
    });
    expect(judge({ title: "id の無い行" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (E) `grant_write: true` は「押せば必ず作れる」の保証ではない
// ---------------------------------------------------------------------------

describe("V14-M1-T03 (E): 関門 (3)(4)(5) を1つも見ていないことの実測", () => {
  test("(E-1) `grant_write: true` の行でも、自分自身への付与は 403 で止まる", async () => {
    const json = await body(
      `/api/apps/${APP_ID}/tables/cases/records/${rowWriter}`,
      actors.viewer.cookie,
    );
    expect((json.access as Record<string, Record<string, boolean>>)[rowWriter]?.grant_write).toBe(
      true,
    );
    // **同じ行に、自分自身(`viewer`)を相手にした付与を作ろうとすると 403 である**
    // (関門 (3) = `self`)。**入口はそれを1バイトも見ていない。**
    const response = await app.request(`/api/apps/${APP_ID}/tables/case_grant/records`, {
      method: "POST",
      headers: {
        cookie: actors.viewer.cookie,
        "content-type": "application/json",
        origin: TEST_ORIGIN,
      },
      body: JSON.stringify({
        case: rowWriter,
        member: members.viewer,
        permission: "reader",
      }),
    });
    expect(response.status).toBe(403);
    // **【2026-09-14 `V18-M8-T02`(`ADR-0445` 決めごと9)】403 がどの層から来たかを文面で固定する。**
    // **着手前の台では `viewer` は付与表に `read` しか持たず、この 403 は面(止めた層: role)が
    // 返していた見込みであった**(関門 (3) を撃っていなかった)。 **台の `viewer` に付与表への
    // 書込を足したので、403 は関門 (3) の文面から来る。** **期待値の 403 は変えていない。**
    const errors = ((await response.json()) as { errors?: { message?: string }[] }).errors;
    expect(errors?.[0]?.message).toBe("自分に権限を付けることはできません。");
  });
});

// ---------------------------------------------------------------------------
// (F) `grant_write` は引き継ぎ(`inherit_from`)を辿る(`V17-M6-T05` / `AC-G30b`)
// ---------------------------------------------------------------------------
//
// **【2026-09-14 `V18-M8-T02`(`ADR-0445` §Decision 7)。上の見出しを1バイトも消していない】**
// **上の見出しの「辿る」は今日の正ではない。** **表示は壁 `judgeGrantWrite` を呼んで
// 関門 (1)(2) を取り、壁の関門 (2) は1段も辿らないので、表示も辿らない。**
// **describe 名も今日の正に直した。旧(逐語)**: 「V17-M6-T05 (F): `grant_write` が引き継ぎを辿る」。

describe("V17-M6-T05 / V18-M8-T02 (F): `grant_write` は引き継ぎを辿らない(壁 `judgeGrantWrite` の答えを取る)", () => {
  test("(F-1) 親にだけ `creator_permission` を持つ人の `grant_write` は一覧で偽である", async () => {
    // **【②振る舞いを反転した(`V18-M8-T02` / `ADR-0445` §Decision 7 が `AC-G30b` の (ii) の実装を覆す)】**
    // **旧の名前(逐語)**: 「(F-1) 親にだけ `creator_permission` を持つ人の `grant_write` が一覧で真である」。
    // **旧の期待値は `grant_write: true`。** **動詞(`read` / `write` / `delete`)の期待値は1つも変えていない。**
    const json = await body(`/api/apps/${APP_ID}/tables/tasks/records`, actors.viewer.cookie);
    const access = json.access as Record<string, Record<string, boolean>>;
    expect(access[taskInherited]).toEqual({
      read: true,
      write: true,
      delete: false,
      grant_write: false,
    });
  });

  test("(F-2) 同じ行の単票でも偽である", async () => {
    // **【②振る舞いを反転した(`V18-M8-T02`)】旧の名前(逐語)**: 「(F-2) 同じ行の単票でも真である」。
    const json = await body(
      `/api/apps/${APP_ID}/tables/tasks/records/${taskInherited}`,
      actors.viewer.cookie,
    );
    const access = json.access as Record<string, Record<string, boolean>>;
    expect(access[taskInherited]?.grant_write).toBe(false);
  });

  test("(F-3) 直接の付与を持つ人は今日どおり真である(緩めても狭めてもいない)", async () => {
    const json = await body(`/api/apps/${APP_ID}/tables/tasks/records`, actors.viewer.cookie);
    const access = json.access as Record<string, Record<string, boolean>>;
    expect(access[taskDirect]?.grant_write).toBe(true);
  });

  test("(F-4) 親に `creator_permission` 以外の権限しか持たない人は偽のままである", async () => {
    const json = await body(`/api/apps/${APP_ID}/tables/tasks/records`, actors.viewer.cookie);
    const access = json.access as Record<string, Record<string, boolean>>;
    // **読めてはいる**(親の `reader` が引き継がれる)—— **配れはしない。**
    expect(access[taskReaderOnly]?.read).toBe(true);
    expect(access[taskReaderOnly]?.grant_write).toBe(false);
  });

  // **【2026-09-14 `V18-M8-T02`(`ADR-0445` 決めごと10)】(F-5) を1本も減らさず「食い違いが無い」を撃つ形へ変えた。**
  // **旧の名前(逐語)**: 「(F-5) 真になった行でも、その人が実際に付与を `POST` すると通らない(食い違いを固定する)」。
  // **旧の期待値(逐語)**: `{ grantWrite: true, status: 404 }`。 **下の本文の旧コメントは消していない** ——
  // **ただし「ボタンは出るのに押すと『無い』と言われる」は今日の正ではない(表示は偽になった)。**
  test("(F-5) 引き継ぎだけの人は `grant_write` が偽で、同じ人が同じ行へ付与を `POST` しても通らない(表示と実際に食い違いが無い)", async () => {
    // **名乗りは `editor` である** —— **`viewer` は表への書込を役割の規則で1つも持たず、
    // 面の層が先に 403(止めた層: role)で止めるので、`judgeGrantWrite` まで1度も届かない。**
    // **`editor` は親(`rowWriter`)にだけ `writer` を持つ**(子への直接の付与は0件)。
    const shown = await body(
      `/api/apps/${APP_ID}/tables/tasks/records/${taskInherited}`,
      actors.editor.cookie,
    );
    const grantWrite = (shown.access as Record<string, Record<string, boolean>>)[taskInherited]
      ?.grant_write;
    const response = await app.request(`/api/apps/${APP_ID}/tables/task_grant/records`, {
      method: "POST",
      headers: {
        cookie: actors.editor.cookie,
        "content-type": "application/json",
        origin: TEST_ORIGIN,
      },
      body: JSON.stringify({
        task: taskInherited,
        member: members.viewer,
        permission: "reader",
      }),
    });
    // **`judgeGrantWrite` の関門 (2) は今日も1段も辿らない**(`ADR-0402` 限定19)——
    // **作成者でも運営でもないと判定され、そのあとの見え方の判定
    // (`judgeRecordAccess`。これも辿らない)で「見えない」に落ちるので、
    // **見えている行なのに 404** が返る。** **ボタンは出るのに押すと「無い」と言われる。**
    // **【禁止】これを「一致した」と書かない。**
    // **食い違いそのものを1本の式で撃つ** —— **「配れる」と出ているのに、押すと
    // 「その行は無い」(404)が返る。** **どちらか片方だけを撃つと、この対が崩れても緑のままになる。**
    //
    // **【2026-09-14 `V18-M8-T02`。上のコメントを1バイトも消していない】** **表示は壁の述語を
    // 呼んで関門 (1)(2) を取るので、引き継ぎだけの人には `grant_write: false` が出る。**
    // **押したときの 404(関門 (2) の「見えない」)は今日も同じである** —— **表示と実際が同じ
    // 答え(配れない)を返す。** **止めた層を文面の逐語で固定する。**
    const message = ((await response.json()) as { errors?: { message?: string }[] }).errors?.[0]
      ?.message;
    expect({ grantWrite, status: response.status, message }).toEqual({
      grantWrite: false,
      status: 404,
      message: `テーブル "tasks" にレコード "${taskInherited}" は存在しません。`,
    });
  });
});

// ---------------------------------------------------------------------------
// (G) `V18-M8-T02`(`ADR-0445` §Decision 4 / §Decision 5): 表示の述語を、壁の述語と
//     「表示の時点で決まる断り」に揃える —— 場面を1本ずつ撃つ
// ---------------------------------------------------------------------------
//
// **各場面で `grant_write`(単票 `GET`)と、同じ人・同じ行への付与の `POST` を同じ1本の式で撃つ。**
// **偽の組は `POST` の `message` の逐語で止めた層を示す。** **真の組は、相手を自分にした `POST` が
// 関門 (3) の文面で止まることで示す**(**`201` を期待値に書かない**。`ADR-0436` 追記4)。

type ErrorJson = { errors?: { message?: string }[] };

const SELF_GRANT_MESSAGE = "自分に権限を付けることはできません。";
const roleDenied = (what: string, verb: string): string =>
  `${what} に対する${verb}は、あなたの役割に許されていません(止めた層: role)。`;

type DeskRole = { id: string; name: string; rules?: Record<string, unknown>[] };
type DeskTable = { id: string; name: string; fields: Record<string, unknown>[] } & Record<
  string,
  unknown
>;
type DeskApp = { roles: DeskRole[]; tables: DeskTable[]; views: Record<string, unknown>[] };

function tableOf(app: DeskApp, id: string): DeskTable {
  const found = app.tables.find((table) => table.id === id);
  if (found === undefined) {
    throw new Error(`台に表 ${id} が無い`);
  }
  return found;
}

function roleOf(app: DeskApp, id: string): DeskRole {
  const found = app.roles.find((role) => role.id === id);
  if (found === undefined) {
    throw new Error(`台に役割 ${id} が無い`);
  }
  return found;
}

function addRule(app: DeskApp, roleId: string, rule: Record<string, unknown>): void {
  const role = roleOf(app, roleId);
  role.rules = [...(role.rules ?? []), rule];
}

const grantFieldsFor = (target: string, targetTable: string, memberTable = "doc_member") => [
  { id: target, name: "対象", type: "reference", reference_table: targetTable },
  { id: "member", name: "相手", type: "reference", reference_table: memberTable },
  { id: "permission", name: "権限", type: "select", options: ["reader", "writer"] },
];

/**
 * **場面の台の設計図**(保護対象 `docs` / 名簿 `doc_member` / 付与表 `doc_grant`)。
 * **`mutate` で場面ごとの差分だけを足す。**
 */
function deskManifest(appId: string, mutate?: (app: DeskApp) => void): Manifest {
  const app: DeskApp = {
    roles: [
      {
        id: "owner",
        name: "持ち主",
        rules: [
          { target: "app", can: ["write"] },
          { target: "role", can: ["write"] },
        ],
      },
      { id: "editor", name: "編集者" },
      { id: "viewer", name: "閲覧者" },
    ],
    tables: [
      {
        id: "docs",
        name: "文書",
        fields: [{ id: "title", name: "題", type: "text", required: true }],
        access_control: {
          enabled: true,
          permissions: [...PERMISSIONS],
          creator_permission: "writer",
          grant: { table: "doc_grant", target: "doc", member: "member", permission: "permission" },
          members: { table: "doc_member", account: "account" },
          creatable_by_roles: ["owner", "editor"],
        },
      },
      {
        id: "doc_member",
        name: "利用者",
        fields: [{ id: "account", name: "ログイン", type: "text" }],
      },
      { id: "doc_grant", name: "文書の付与", fields: grantFieldsFor("doc", "docs") },
    ],
    views: [],
  };
  mutate?.(app);
  return { app: { id: appId, name: "権限配布の台", ...app } } as unknown as Manifest;
}

/** **付与表 `doc_grant` そのものに宣言を持たせる**((viii) の3形)。 */
function grantTableDeclares(more: Record<string, unknown>): (app: DeskApp) => void {
  return (app) => {
    tableOf(app, "doc_grant").access_control = {
      enabled: true,
      permissions: [...PERMISSIONS],
      creator_permission: "writer",
      grant: {
        table: "doc_grant_grant",
        target: "grant_row",
        member: "member",
        permission: "permission",
      },
      members: { table: "doc_member", account: "account" },
      ...more,
    };
    app.tables.push({
      id: "doc_grant_grant",
      name: "付与の付与",
      fields: grantFieldsFor("grant_row", "doc_grant"),
    });
  };
}

type Desk = {
  appId: string;
  cookies: Record<SignedIn, string>;
  members: Partial<Record<SignedIn, string>>;
  doc: string;
  ids: Record<string, string>;
};

/**
 * **場面の台を同じ `dataRoot` に1本立てる。**
 * **既定の付与**: `editor` と `viewer` に `doc` の `writer`、`owner` に `reader`(行が見えるように)。
 */
function setupDesk(input: {
  appId: string;
  manifest: Manifest;
  skipTables?: readonly string[];
  skipAllViews?: boolean;
  memberless?: readonly SignedIn[];
  grantTable?: string;
  seed?: (
    make: (table: string, values: Record<string, unknown>) => string,
    desk: { members: Partial<Record<SignedIn, string>>; doc: string },
  ) => Record<string, string>;
}): Desk {
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "権限配布の台", { app_id: input.appId });
  } finally {
    store.close();
  }
  const applied = applyManifest(
    dataRoot,
    input.appId,
    withDefaultRoleRules(input.manifest, {
      skipTables: input.skipTables ?? ["docs"],
      ...(input.skipAllViews === true ? { skipAllViews: true } : {}),
    }),
  );
  expect({ appId: input.appId, valid: applied.valid }).toEqual({
    appId: input.appId,
    valid: true,
  });
  const cookies = {} as Record<SignedIn, string>;
  const userIds = {} as Record<SignedIn, string>;
  for (const role of SIGNED_IN) {
    const seeded = seedSession(dataRoot, input.appId, { role, username: `d-${role}` });
    cookies[role] = seeded.cookie;
    userIds[role] = seeded.userId;
  }
  const members: Partial<Record<SignedIn, string>> = {};
  let doc = "";
  let ids: Record<string, string> = {};
  const db = new Database(appDbPath(dataRoot, input.appId), { readwrite: true, create: false });
  try {
    const make = (table: string, values: Record<string, unknown>): string => {
      const created = createRecord(db, input.manifest, table, values);
      expect({ table, ok: created.ok }).toEqual({ table, ok: true });
      return (created as { value: { _id: string } }).value._id;
    };
    for (const role of SIGNED_IN) {
      if (!(input.memberless ?? []).includes(role)) {
        members[role] = make("doc_member", { account: userIds[role] });
      }
    }
    doc = make("docs", { title: "配る対象の文書" });
    const grantTable = input.grantTable ?? "doc_grant";
    for (const [role, permission] of [
      ["editor", "writer"],
      ["viewer", "writer"],
      ["owner", "reader"],
    ] as const) {
      if (members[role] !== undefined) {
        make(grantTable, { doc, member: members[role], permission });
      }
    }
    ids = input.seed?.(make, { members, doc }) ?? {};
  } finally {
    db.close();
  }
  return { appId: input.appId, cookies, members, doc, ids };
}

/** **単票 `GET` の `grant_write`**(200 以外なら応答コードを文字列で返す)。 */
async function shownGrantWrite(
  desk: Desk,
  who: SignedIn,
  tableId = "docs",
  recordId = desk.doc,
): Promise<unknown> {
  const response = await app.request(
    `/api/apps/${desk.appId}/tables/${tableId}/records/${recordId}`,
    { headers: { cookie: desk.cookies[who] } },
  );
  if (response.status !== 200) {
    return `status ${response.status}`;
  }
  const json = (await response.json()) as { access?: Record<string, Record<string, boolean>> };
  return json.access?.[recordId]?.grant_write;
}

/** **付与の `POST`**(応答コードと、断りの1件目の `message`)。 */
async function postGrant(
  desk: Desk,
  who: SignedIn,
  values: Record<string, unknown>,
  grantTable = "doc_grant",
): Promise<{ status: number; message: string | undefined }> {
  const response = await app.request(`/api/apps/${desk.appId}/tables/${grantTable}/records`, {
    method: "POST",
    headers: {
      cookie: desk.cookies[who],
      "content-type": "application/json",
      origin: TEST_ORIGIN,
    },
    body: JSON.stringify(values),
  });
  const json = (await response.json()) as ErrorJson;
  return { status: response.status, message: json.errors?.[0]?.message };
}

describe("V18-M8-T02 (G): 表示の述語が、壁の述語と表示の時点で決まる断りに揃う", () => {
  test("(G-0) 表示の呼び方(相手の欄を載せない create)では、壁は6つの判定値しか返さない(fail-closed の前提)", () => {
    // **`ADR-0445` §Decision 5 の読み替え表の「返らないはず」を固定する。**
    // **`values` に相手の欄を載せないので、`allowed` / `self` / `parent_denied` は返りようがない。**
    const rows: Record<string, Record<string, unknown>[]> = {
      cases: [{ _id: "c1", title: "案件" }],
      case_member: [
        { _id: "m1", account: "u1" },
        { _id: "m2", account: "u2" },
      ],
      case_grant: [
        { _id: "g1", case: "c1", member: "m1", permission: "writer" },
        { _id: "g2", case: "c1", member: "m2", permission: "reader" },
      ],
    };
    const readRows = (id: string) => rows[id] ?? [];
    const readRow = (id: string, recordId: string) =>
      readRows(id).find((row) => row._id === recordId);
    const seen = new Set<string>();
    const shapes: [string, Record<string, unknown>][] = [
      ["case_grant", { case: "c1" }],
      ["case_grant", { case: "no-such-row" }],
      ["case_grant", {}],
      ["case_member", { case: "c1" }],
      ["plain", { case: "c1" }],
    ];
    for (const [tableId, values] of shapes) {
      for (const actorId of ["u1", "u2", "u3", null]) {
        for (const role of ["owner", "editor", "viewer", null] as const) {
          const verdict = judgeGrantWrite({
            manifest: manifest(),
            tableId,
            op: "create",
            values,
            actorId,
            role,
            readRows,
            readRow,
          });
          seen.add(verdict === undefined ? "undefined" : verdict.kind);
        }
      }
    }
    expect([...seen].sort()).toEqual([
      "invisible_target",
      "membership_locked",
      "no_target",
      "not_creator",
      "undefined",
      "unknown_holder",
    ]);
  });

  test("(G-1) (i) 引き継ぎだけの人(面で付与表に書ける)は偽で、POST は関門 (2) の 404 で止まる", async () => {
    const shown = await body(
      `/api/apps/${APP_ID}/tables/tasks/records/${taskInherited}`,
      actors.viewer.cookie,
    );
    const grantWrite = (shown.access as Record<string, Record<string, boolean>>)[taskInherited]
      ?.grant_write;
    const response = await app.request(`/api/apps/${APP_ID}/tables/task_grant/records`, {
      method: "POST",
      headers: {
        cookie: actors.viewer.cookie,
        "content-type": "application/json",
        origin: TEST_ORIGIN,
      },
      body: JSON.stringify({ task: taskInherited, member: members.editor, permission: "reader" }),
    });
    const message = ((await response.json()) as ErrorJson).errors?.[0]?.message;
    expect({ grantWrite, status: response.status, message }).toEqual({
      grantWrite: false,
      status: 404,
      message: `テーブル "tasks" にレコード "${taskInherited}" は存在しません。`,
    });
  });

  test("(G-2) (ii) 面で付与表に書けない直接の作成者は偽で、POST は面で止まる", async () => {
    const desk = setupDesk({ appId: "desk-g2", manifest: deskManifest("desk-g2") });
    const shown = await shownGrantWrite(desk, "viewer");
    const posted = await postGrant(desk, "viewer", {
      doc: desk.doc,
      member: desk.members.editor,
      permission: "reader",
    });
    expect({ shown, ...posted }).toEqual({
      shown: false,
      status: 403,
      message: roleDenied('表 "doc_grant"', "書き込み"),
    });
  });

  test("(G-3) (iii) 面で付与表に書ける直接の作成者は真で、自分宛の POST は関門 (3) で止まる", async () => {
    const desk = setupDesk({ appId: "desk-g3", manifest: deskManifest("desk-g3") });
    const shown = await shownGrantWrite(desk, "editor");
    const posted = await postGrant(desk, "editor", {
      doc: desk.doc,
      member: desk.members.editor,
      permission: "reader",
    });
    expect({ shown, ...posted }).toEqual({ shown: true, status: 403, message: SELF_GRANT_MESSAGE });
  });

  test("(G-4) (iv) 運営ロールは作成者でなくても真で、自分宛の POST は関門 (3) で止まる", async () => {
    const desk = setupDesk({ appId: "desk-g4", manifest: deskManifest("desk-g4") });
    const shown = await shownGrantWrite(desk, "owner");
    const posted = await postGrant(desk, "owner", {
      doc: desk.doc,
      member: desk.members.owner,
      permission: "writer",
    });
    expect({ shown, ...posted }).toEqual({ shown: true, status: 403, message: SELF_GRANT_MESSAGE });
  });

  test("(G-5) (v) 付与表が別の表の名簿表としても名指しされる形では、運営以外は偽で、POST は所属の穴で止まる", async () => {
    const desk = setupDesk({
      appId: "desk-g5",
      skipTables: ["docs", "folders"],
      manifest: deskManifest("desk-g5", (app) => {
        tableOf(app, "doc_grant").fields.push({ id: "account", name: "ログイン", type: "text" });
        app.tables.push({
          id: "folders",
          name: "フォルダ",
          fields: [{ id: "title", name: "題", type: "text", required: true }],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "writer",
            grant: {
              table: "folder_grant",
              target: "folder",
              member: "member",
              permission: "permission",
            },
            members: { table: "doc_grant", account: "account" },
            creatable_by_roles: ["owner", "editor"],
          },
        });
        app.tables.push({
          id: "folder_grant",
          name: "フォルダの付与",
          fields: grantFieldsFor("folder", "folders", "doc_grant"),
        });
      }),
    });
    const shownEditor = await shownGrantWrite(desk, "editor");
    const posted = await postGrant(desk, "editor", {
      doc: desk.doc,
      member: desk.members.viewer,
      permission: "reader",
    });
    const shownOwner = await shownGrantWrite(desk, "owner");
    expect({ shownEditor, ...posted, shownOwner }).toEqual({
      shownEditor: false,
      status: 403,
      message: "参加者の表は、アプリの運営者だけが書き換えられます。",
      shownOwner: true,
    });
  });

  test("(G-6) (vi) 付与表が `st_no_direct_create` を持つと偽で、POST は直接作成の遮断で止まる", async () => {
    const desk = setupDesk({
      appId: "desk-g6",
      manifest: deskManifest("desk-g6", (app) => {
        tableOf(app, "doc_grant").fields.push({
          id: "st_no_direct_create",
          name: "直接作成しない",
          type: "boolean",
        });
      }),
    });
    const shown = await shownGrantWrite(desk, "editor");
    const posted = await postGrant(desk, "editor", {
      doc: desk.doc,
      member: desk.members.viewer,
      permission: "reader",
    });
    expect({ shown, ...posted }).toEqual({
      shown: false,
      status: 403,
      message: 'テーブル "doc_grant" は、画面や API から直接レコードを作れないと宣言されています。',
    });
  });

  test("(G-7) (vii) 付与表へ作るボタンが面で名指しされ、本人に許されていないと偽で、POST はボタンの規則で止まる", async () => {
    const desk = setupDesk({
      appId: "desk-g7",
      skipAllViews: true,
      manifest: deskManifest("desk-g7", (app) => {
        app.views.push(
          {
            id: "doc-list",
            type: "list_view",
            table: "docs",
            columns: ["title"],
            actions: [
              { id: "give", form: "grant-form", prefill: { field: "doc" }, name: "権限を配る" },
            ],
          },
          {
            id: "grant-form",
            type: "form",
            table: "doc_grant",
            fields: ["doc", "member", "permission"],
          },
        );
        addRule(app, "owner", {
          target: "action",
          view: "doc-list",
          action: "give",
          can: ["read"],
        });
      }),
    });
    const shownEditor = await shownGrantWrite(desk, "editor");
    const posted = await postGrant(desk, "editor", {
      doc: desk.doc,
      member: desk.members.viewer,
      permission: "reader",
    });
    const shownOwner = await shownGrantWrite(desk, "owner");
    expect({ shownEditor, ...posted, shownOwner }).toEqual({
      shownEditor: false,
      status: 403,
      message: roleDenied('表 "doc_grant" のボタン', "作成"),
      shownOwner: true,
    });
  });

  test("(G-8a) (viii) 付与表そのものが `creatable_by_roles` を宣言し、本人の立場が挙がっていないと偽で、POST はその関門で止まる", async () => {
    const desk = setupDesk({
      appId: "desk-g8a",
      manifest: deskManifest("desk-g8a", grantTableDeclares({ creatable_by_roles: ["owner"] })),
    });
    const shown = await shownGrantWrite(desk, "editor");
    const posted = await postGrant(desk, "editor", {
      doc: desk.doc,
      member: desk.members.viewer,
      permission: "reader",
    });
    expect({ shown, ...posted }).toEqual({
      shown: false,
      status: 403,
      message:
        "この表に行を作れる立場が決められており、あなたの立場はそこに挙がっていないため、行を作れません。",
    });
  });

  test("(G-8b) (viii) 付与表そのものが `inherit_from` で対象の欄を指すと、元の行に書けない運営は偽で、POST は親の関門で止まる", async () => {
    const desk = setupDesk({
      appId: "desk-g8b",
      manifest: deskManifest("desk-g8b", grantTableDeclares({ inherit_from: ["doc"] })),
    });
    // **運営は `doc` に `reader` しか持たない**(元の行に書けない)。 **編集者は `writer`(書ける)。**
    const shownOwner = await shownGrantWrite(desk, "owner");
    const posted = await postGrant(desk, "owner", {
      doc: desk.doc,
      member: desk.members.viewer,
      permission: "reader",
    });
    const shownEditor = await shownGrantWrite(desk, "editor");
    const editorSelf = await postGrant(desk, "editor", {
      doc: desk.doc,
      member: desk.members.editor,
      permission: "reader",
    });
    expect({ shownOwner, ...posted, shownEditor, editorSelf }).toEqual({
      shownOwner: false,
      status: 403,
      message:
        "この表の行は、元になる行に書き込める人だけが作れます。あなたには、指定された元の行を書き換える権限がありません。",
      shownEditor: true,
      editorSelf: { status: 403, message: SELF_GRANT_MESSAGE },
    });
  });

  test("(G-8c) (viii) 付与表そのものが宣言を持ち、名乗りが名簿に居ない運営は偽で、POST は作成者の付与の計画で止まる", async () => {
    const desk = setupDesk({
      appId: "desk-g8c",
      memberless: ["owner"],
      manifest: deskManifest("desk-g8c", (app) => {
        grantTableDeclares({ creatable_by_roles: ["owner", "editor"] })(app);
        // **運営は名簿に居ないので付与では行が見えない** —— **面で `docs` を読めるようにする。**
        addRule(app, "owner", { target: "table", table: "docs", can: ["read"] });
      }),
    });
    const shown = await shownGrantWrite(desk, "owner");
    const posted = await postGrant(desk, "owner", {
      doc: desk.doc,
      member: desk.members.viewer,
      permission: "reader",
    });
    expect({ shown, ...posted }).toEqual({
      shown: false,
      status: 400,
      message:
        "この表に行を作れるのは、このアプリの利用者の表に登録されている人だけです。あなたはまだ登録されていません。",
    });
  });

  test("(G-9) (x) 対象の欄に書込禁止の項目規則があると偽で、POST は項目の規則で止まる", async () => {
    const desk = setupDesk({
      appId: "desk-g9",
      manifest: deskManifest("desk-g9", (app) => {
        addRule(app, "editor", {
          target: "field",
          table: "doc_grant",
          field: "doc",
          can: ["read"],
        });
      }),
    });
    const shown = await shownGrantWrite(desk, "editor");
    const posted = await postGrant(desk, "editor", {
      doc: desk.doc,
      member: desk.members.viewer,
      permission: "reader",
    });
    expect({ shown, ...posted }).toEqual({
      shown: false,
      status: 403,
      message: roleDenied('項目 "doc"', "書き込み"),
    });
  });

  test("(G-10) (x) 宣言された相手の欄が全部書込禁止だと偽で、POST は項目の規則で止まる", async () => {
    const desk = setupDesk({
      appId: "desk-g10",
      manifest: deskManifest("desk-g10", (app) => {
        addRule(app, "editor", {
          target: "field",
          table: "doc_grant",
          field: "member",
          can: ["read"],
        });
      }),
    });
    const shown = await shownGrantWrite(desk, "editor");
    const posted = await postGrant(desk, "editor", {
      doc: desk.doc,
      member: desk.members.viewer,
      permission: "reader",
    });
    expect({ shown, ...posted }).toEqual({
      shown: false,
      status: 403,
      message: roleDenied('項目 "member"', "書き込み"),
    });
  });

  test("(G-11) (h3-b) 必須でない `permission` の欄だけが書込禁止なら写さない —— 真のまま、送ると断られる形が残る(限界)", async () => {
    const desk = setupDesk({
      appId: "desk-g11",
      manifest: deskManifest("desk-g11", (app) => {
        addRule(app, "editor", {
          target: "field",
          table: "doc_grant",
          field: "permission",
          can: ["read"],
        });
      }),
    });
    const shown = await shownGrantWrite(desk, "editor");
    // **`permission` を送らない自分宛の POST は、面でも項目でも止まらず関門 (3) で止まる。**
    const selfWithout = await postGrant(desk, "editor", {
      doc: desk.doc,
      member: desk.members.editor,
    });
    // **`permission` を送ると項目の規則で断られる** —— **「配れる」と出て押すと断られる形が残る。**
    const withPermission = await postGrant(desk, "editor", {
      doc: desk.doc,
      member: desk.members.viewer,
      permission: "reader",
    });
    expect({ shown, selfWithout, withPermission }).toEqual({
      shown: true,
      selfWithout: { status: 403, message: SELF_GRANT_MESSAGE },
      withPermission: { status: 403, message: roleDenied('項目 "permission"', "書き込み") },
    });
  });

  test("(G-12) (h3-b) 必須の `permission` の欄が書込禁止なら写す —— 偽で、POST は項目の規則で止まる", async () => {
    const desk = setupDesk({
      appId: "desk-g12",
      manifest: deskManifest("desk-g12", (app) => {
        const permission = tableOf(app, "doc_grant").fields.find(
          (field) => field.id === "permission",
        );
        if (permission !== undefined) {
          permission.required = true;
        }
        addRule(app, "editor", {
          target: "field",
          table: "doc_grant",
          field: "permission",
          can: ["read"],
        });
      }),
    });
    const shown = await shownGrantWrite(desk, "editor");
    const posted = await postGrant(desk, "editor", {
      doc: desk.doc,
      member: desk.members.viewer,
      permission: "reader",
    });
    expect({ shown, ...posted }).toEqual({
      shown: false,
      status: 403,
      message: roleDenied('項目 "permission"', "書き込み"),
    });
  });

  test("(G-13) (h5) 付与表に条件つきの規則だけがある形は評価しない —— 真のまま、条件に合わない値を送ると断られる形が残る(限界)", async () => {
    const desk = setupDesk({
      appId: "desk-g13",
      manifest: deskManifest("desk-g13", (app) => {
        addRule(app, "editor", {
          target: "table",
          table: "doc_grant",
          can: ["read", "write"],
          when: { field: "permission", equals: "reader" },
        });
      }),
    });
    const shown = await shownGrantWrite(desk, "editor");
    const posted = await postGrant(desk, "editor", {
      doc: desk.doc,
      member: desk.members.viewer,
      permission: "writer",
    });
    expect({ shown, ...posted }).toEqual({
      shown: true,
      status: 403,
      message: roleDenied('表 "doc_grant" のこの行', "作成"),
    });
  });

  test("(G-14) 1つの付与表を2つの表が名指しする形: 対象の欄1つなら表示と一致し、対象の欄を2つ入れた要求ではずれる(限界)", async () => {
    // **servicedesk の e2e(`web/e2e/access-control-servicedesk.e2e.ts:170`-`:175`)と同じ形** ——
    // **付与表 `shared_grant` は1本で、`folders` と `docs` が同じ表を名指しし、対象の列だけが違う。**
    // **`folders` を設計図の先に置く**(壁は設計図の順で、対象の欄が埋まっている最初の表を選ぶ)。
    const desk = setupDesk({
      appId: "desk-g14",
      skipTables: ["docs", "folders"],
      grantTable: "shared_grant",
      manifest: deskManifest("desk-g14", (app) => {
        const docs = tableOf(app, "docs");
        docs.access_control = {
          ...(docs.access_control as Record<string, unknown>),
          grant: {
            table: "shared_grant",
            target: "doc",
            member: "member",
            permission: "permission",
          },
        };
        app.tables = app.tables.filter((table) => table.id !== "doc_grant");
        app.tables.unshift({
          id: "folders",
          name: "フォルダ",
          fields: [{ id: "title", name: "題", type: "text", required: true }],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "writer",
            grant: {
              table: "shared_grant",
              target: "folder",
              member: "member",
              permission: "permission",
            },
            members: { table: "doc_member", account: "account" },
            creatable_by_roles: ["owner", "editor"],
          },
        });
        app.tables.push({
          id: "shared_grant",
          name: "共通の付与",
          fields: [
            { id: "folder", name: "フォルダ", type: "reference", reference_table: "folders" },
            ...grantFieldsFor("doc", "docs"),
          ],
        });
      }),
      seed: (make, { members: seeded }) => {
        const folder = make("folders", { title: "運営だけのフォルダ" });
        make("shared_grant", { folder, member: seeded.owner, permission: "writer" });
        return { folder };
      },
    });
    const shown = await shownGrantWrite(desk, "editor");
    const selfOneTarget = await postGrant(
      desk,
      "editor",
      { doc: desk.doc, member: desk.members.editor, permission: "reader" },
      "shared_grant",
    );
    const twoTargets = await postGrant(
      desk,
      "editor",
      { folder: desk.ids.folder, doc: desk.doc, member: desk.members.viewer, permission: "reader" },
      "shared_grant",
    );
    expect({ shown, selfOneTarget, twoTargets }).toEqual({
      shown: true,
      selfOneTarget: { status: 403, message: SELF_GRANT_MESSAGE },
      twoTargets: {
        status: 404,
        message: `テーブル "folders" にレコード "${desk.ids.folder}" は存在しません。`,
      },
    });
  });
});
