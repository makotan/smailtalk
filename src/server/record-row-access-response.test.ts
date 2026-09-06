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
import { OWNER_FIELD, rowGrantWriteJudge } from "./owner-scope.ts";
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
      withDefaultRoleRules(manifest(), { skipTables: ["cases", "owned", "memos"] }),
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
  });
});
