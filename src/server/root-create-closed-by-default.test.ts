/**
 * **`V18-M5-T01` / 審査の単位 `PM-G2` / `ADR-0432`(決定の本体)/ `ADR-0442`(授権)**:
 * **根の表に「行を作れる立場」が**一行も書かれていない**とき、画面と HTTP の口から
 * 行を作れなくする**(既定を「誰でも作れる」から「作れない」へ反転する)。
 *
 * ## 何を測るか(本葉の完了条件の逐語)
 *
 * > **`enabled: true` の根の表で `creatable_by_roles` を宣言していないアプリへの
 * > `POST /api/apps/:app_id/tables/:table_id/records` が、名簿に登録済みの利用者からでも
 * > **403** になる。** **宣言した表 / 権限管理を宣言していない表 / `enabled: false` の表 /
 * > `inherit_from` を宣言した表 では、着手前と1バイトも変わらない。**
 *
 * **実 HTTP で叩く**(`root-creatable-roles.test.ts` とまったく同じ作法)——
 * **`app.request` は本物の `createServerApp` であり、行は本物の SQLite に書かれる。**
 *
 * | # | 何を撃つか | **着手時(本葉が実際に見た赤 / 緑)** |
 * | --- | --- | --- |
 * | `(A-1)` | 区分C(宣言が一行も無い根の表)へ、名簿に登録済みの一般利用者が単件 `POST` | **赤(`201`)** |
 * | `(A-2)` | **同じ表へ運営(`owner`)でも 403**(`D-V18-28`。例外を1つも置かない) | **赤(`201`)** |
 * | `(A-3)` | 同じ表へ**まとめ書き**でも 403(単件だけを撃たない) | **赤(`200`)** |
 * | `(A-4)` | 断り文に内部記号が1文字も無い | **赤**(断り自体が無い) |
 * | `(A-5)` | **2つの断り文が使い分けられている**(「挙がっていない」と「一行も書いていない」) | **赤**(2本目が無い) |
 * | `(B-1)` | 区分D(宣言した表)—— 挙がっている役割は今日どおり作れる【陰性対照】 | 緑(`201`) |
 * | `(B-2)` | 区分D —— 挙がっていない役割は今日どおり断られる【陰性対照】 | 緑(`403`) |
 * | `(B-3)` | 区分D —— まとめ書きも今日どおり【陰性対照】 | 緑(`200`) |
 * | `(C-1)` | **区分A**(権限管理を一行も宣言していない表)は1バイトも変わらない(`D-V18-27`) | 緑(`201`) |
 * | `(C-2)` | **`enabled: false` の表**は1バイトも変わらない | 緑(`201`) |
 * | `(C-3)` | **`inherit_from` を宣言し、9キー目を書いていない表では素通りする** | **赤**(既定を反転すると止まる) |
 * | `(D-1)` | **更新(`PATCH`)に1ミリも掛かっていない** | 緑(`200`) |
 * | `(D-2)` | **削除(`DELETE`)に1ミリも掛かっていない** | 緑(`204`) |
 *
 * **【`(C-3)` を新しく1本足した理由。既存の検査は**この場合を1度も撃っていない**】** ——
 * **`root-creatable-roles.test.ts` の `(c-1)` の題材は
 * `{ inherit_from: ["parent"], creatable_by_roles: ["editor"] }` であり、**9キー目を
 * 宣言している**。** **したがって既定を反転しても9キー目の枝に入らず、判定順を
 * 入れ替えても入れ替えても**緑のままである**。** **「引き継ぎあり かつ 9キー目なし」
 * (= 実地の `team-tasks` の `milestones` / `issues` の形)を撃つ検査は、着手時点で
 * **1本も無かった**。**
 *
 * **【この検査が測っていないもの。誇張しない】**
 *  - **AI の口を1度も呼んでいない** —— **それは `V18-M5-T02` の担当である。**
 *  - **受信口 / 自動処理 / 島 / 時刻起動 からの作成を1度も撃っていない** ——
 *    **本段はこの4本に1ビットも掛けない**(`D-V18-6`)。 **どれも今日も素通りする。**
 *  - **画面(`web/src/`)の「作成ボタンを出すか」の判定を1度も撃っていない** ——
 *    **本葉は画面を1バイトも変えない。**
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
import { judgeRootCreatableRoles } from "./owner-scope.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "root-create-closed";

const PERMISSIONS = [
  { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
  { id: "writer", name: "編集できる", read: true, write: true, delete: true },
] as const;

/** 根の表の宣言(**`inherit_from` を1本も書かない**)。 */
function declaration(target: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    permissions: [...PERMISSIONS],
    creator_permission: "writer",
    grant: { table: "ac_grant", target, member: "member", permission: "permission" },
    members: { table: "ac_member", account: "account" },
    ...extra,
  };
}

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "既定を閉じる",
      tables: [
        {
          // **区分C** —— **権限管理は宣言しているが、9キー目を1文字も書いていない根の表。**
          id: "silent",
          name: "宣言の無い持ち場",
          fields: [{ id: "title", name: "件名", type: "text", required: true }],
          access_control: declaration("silent"),
        },
        {
          // **区分D** —— **9キー目を宣言した表**(退行の担保に使う)。
          id: "declared",
          name: "宣言した持ち場",
          fields: [{ id: "title", name: "件名", type: "text", required: true }],
          access_control: declaration("declared", { creatable_by_roles: ["editor"] }),
        },
        {
          // **`enabled: false`** —— **宣言していない表とまったく同じ扱いになるはずの形。**
          id: "disabled",
          name: "止めてある持ち場",
          fields: [{ id: "title", name: "件名", type: "text", required: true }],
          access_control: declaration("disabled", { enabled: false }),
        },
        {
          // **区分A** —— **権限管理を1バイトも宣言していない表**(`D-V18-27`)。
          id: "plain",
          name: "宣言の無い表",
          fields: [{ id: "title", name: "件名", type: "text", required: true }],
        },
        {
          id: "ac_grant",
          name: "付与",
          fields: [
            {
              id: "silent",
              name: "宣言の無い持ち場",
              type: "reference",
              reference_table: "silent",
            },
            {
              id: "declared",
              name: "宣言した持ち場",
              type: "reference",
              reference_table: "declared",
            },
            {
              id: "disabled",
              name: "止めてある持ち場",
              type: "reference",
              reference_table: "disabled",
            },
            { id: "member", name: "相手", type: "reference", reference_table: "ac_member" },
            { id: "permission", name: "権限", type: "select", options: ["reader", "writer"] },
          ],
        },
        {
          id: "ac_member",
          name: "利用者",
          fields: [{ id: "account", name: "ログイン", type: "text" }],
        },
      ],
      views: [],
    },
  } as unknown as Manifest;
}

/**
 * **面の規則を足すのは `plain` と `disabled` の2本だけである** ——
 * **守られている表へ足すと `OR` で面の答えが通り、測りたい壁が測れなくなる。**
 * **`disabled` は `enabled: false` なので守られている側ではない**(面が要る)。
 */
function manifestWithRoles(): Manifest {
  const base = manifest();
  const open = new Set(["plain", "disabled"]);
  return withDefaultRoleRules(base, {
    skipTables: base.app.tables.map((table) => table.id).filter((id) => !open.has(id)),
    skipAllViews: true,
  });
}

let dataRoot = "";
let app: ReturnType<typeof createServerApp>;
let editorUser: ReturnType<typeof seedSession>;
let ownerUser: ReturnType<typeof seedSession>;
let viewerUser: ReturnType<typeof seedSession>;
let silentRowId = "";

function withDb<T>(run: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

async function create(
  table: string,
  cookie: string,
  values: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  const response = await app.request(`/api/apps/${APP_ID}/tables/${table}/records`, {
    method: "POST",
    headers: { cookie, origin: TEST_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(values),
  });
  return { status: response.status, body: await response.text() };
}

async function batchCreate(
  table: string,
  cookie: string,
  values: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  const response = await app.request(`/api/apps/${APP_ID}/batch`, {
    method: "POST",
    headers: { cookie, origin: TEST_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ ops: [{ op: "create", table, values }] }),
  });
  return { status: response.status, body: await response.text() };
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-rccd-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "既定を閉じる", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, manifestWithRoles()).valid).toBe(true);
  app = createServerApp({ dataRoot });

  editorUser = seedSession(dataRoot, APP_ID, { role: "editor", username: "editor-user" });
  ownerUser = seedSession(dataRoot, APP_ID, { role: "owner", username: "owner-user" });
  viewerUser = seedSession(dataRoot, APP_ID, { role: "viewer", username: "viewer-user" });

  const loaded = manifest();
  withDb((db) => {
    const id = (result: unknown): string => (result as { value: { _id: string } }).value._id;
    const member = (account: string): string =>
      id(createRecord(db, loaded, "ac_member", { account }));
    // **3人とも名簿に載せる** —— **「登録されていない」の 400 と混ぜないため。**
    const editorMember = member(editorUser.userId);
    member(ownerUser.userId);
    member(viewerUser.userId);

    // **更新 / 削除の材料**(作成の壁とは別の枝であることを見る)。
    silentRowId = id(createRecord(db, loaded, "silent", { title: "既に在る行" }));
    expect(
      createRecord(db, loaded, "ac_grant", {
        silent: silentRowId,
        member: editorMember,
        permission: "writer",
      }).ok,
    ).toBe(true);
  });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (A) 区分C —— 一行も書かれていない根の表では、誰も作れない
// ---------------------------------------------------------------------------

describe("V18-M5 (A): 立場が一行も書かれていない根の表では作れない", () => {
  test("(A-1) 名簿に登録済みの一般利用者でも作れない(403)", async () => {
    const out = await create("silent", editorUser.cookie, { title: "作る" });
    expect(out.status).toBe(403);
  });

  test("(A-2) 運営(owner)でも作れない(403)【`D-V18-28`。例外を1つも置かない】", async () => {
    const out = await create("silent", ownerUser.cookie, { title: "作る" });
    expect(out.status).toBe(403);
  });

  test("(A-3) まとめ書きの口でも作れない(403)", async () => {
    const out = await batchCreate("silent", ownerUser.cookie, { title: "作る" });
    expect(out.status).toBe(403);
  });

  test("(A-4) 断り文に内部記号が1文字も無い", async () => {
    const out = await create("silent", ownerUser.cookie, { title: "作る" });
    expect(out.status).toBe(403);
    for (const symbol of [
      "access_control",
      "creatable_by",
      "creatable_by_roles",
      "inherit_from",
      "creator_permission",
      "silent",
      "owner",
      "editor",
      "viewer",
      "judgeRootCreatableRoles",
      "PM-G",
      "AC-G",
      "ADR-",
      "D-V18",
    ]) {
      expect({ symbol, leaked: out.body.includes(symbol) }).toEqual({ symbol, leaked: false });
    }
  });

  test("(A-5) 2つの断り文が使い分けられている(挙がっていない / 一行も書いていない)", async () => {
    const undeclared = await create("silent", ownerUser.cookie, { title: "作る" });
    const notListed = await create("declared", ownerUser.cookie, { title: "作る" });
    expect({ undeclared: undeclared.status, notListed: notListed.status }).toEqual({
      undeclared: 403,
      notListed: 403,
    });
    // **同じ文面を使い回していない** —— **止めている理由が違うからである。**
    expect(undeclared.body).not.toBe(notListed.body);
    // **一行も書かれていない側の文面は「決められており」で始まってはならない。**
    expect(undeclared.body.includes("決められており")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (B) 区分D —— 宣言した表は着手前と同じ応答(退行の担保)
// ---------------------------------------------------------------------------

describe("V18-M5 (B): 宣言した表は着手前と同じ応答", () => {
  test("(B-1) 挙がっている役割は作れる(201)【陰性対照】", async () => {
    const out = await create("declared", editorUser.cookie, { title: "作る" });
    expect(out.status).toBe(201);
  });

  test("(B-2) 挙がっていない役割は断られる(403)【陰性対照】", async () => {
    const out = await create("declared", ownerUser.cookie, { title: "作る" });
    expect(out.status).toBe(403);
  });

  test("(B-3) まとめ書きでも挙がっている役割は作れる(200)【陰性対照】", async () => {
    const out = await batchCreate("declared", editorUser.cookie, { title: "作る" });
    expect(out.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// (C) 掛からないところは1バイトも変わらない
// ---------------------------------------------------------------------------

describe("V18-M5 (C): 掛からないところは1バイトも変わらない", () => {
  test("(C-1) 権限管理を一行も宣言していない表は今日どおり作れる(201)【`D-V18-27`】", async () => {
    const out = await create("plain", ownerUser.cookie, { title: "作る" });
    expect(out.status).toBe(201);
  });

  test("(C-2) `enabled: false` の表も今日どおり作れる(201)", async () => {
    const out = await create("disabled", ownerUser.cookie, { title: "作る" });
    expect(out.status).toBe(201);
  });

  test("(C-3) `inherit_from` を宣言し、9キー目を書いていない表では素通りする", () => {
    // **【この1本が本葉の TDD の要である】** —— **既存の `(c-1)` は 9キー目を
    // **宣言している**題材なので、この場合を1度も撃っていない。**
    // **入れ替えないと、引き継ぎを宣言した実地の表(`team-tasks` の
    // `milestones` / `issues`)まで止まる。**
    const verdict = judgeRootCreatableRoles({
      manifest: {
        app: {
          id: APP_ID,
          name: "述語",
          roles: [
            { id: "owner", name: "持ち主" },
            { id: "editor", name: "編集者" },
            { id: "viewer", name: "閲覧者" },
          ],
          tables: [
            {
              id: "t",
              name: "表",
              fields: [
                { id: "title", name: "件名", type: "text" },
                { id: "parent", name: "親", type: "reference", reference_table: "t" },
              ],
              access_control: declaration("t", { inherit_from: ["parent"] }),
            },
          ],
          views: [],
        },
      } as unknown as Manifest,
      tableId: "t",
      roles: "viewer",
    });
    // **止めない側の答えである**(3値のうち「通す」)。
    expect(verdict).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// (D) 更新と削除には1ミリも掛かっていない
// ---------------------------------------------------------------------------

describe("V18-M5 (D): 更新と削除には1ミリも掛かっていない", () => {
  test("(D-1) 更新(PATCH)は通る(200)【陰性対照】", async () => {
    const path = `/api/apps/${APP_ID}/tables/silent/records/${silentRowId}`;
    const current = await app.request(path, {
      headers: { cookie: editorUser.cookie, origin: TEST_ORIGIN },
    });
    expect(current.status).toBe(200);
    const response = await app.request(path, {
      method: "PATCH",
      headers: {
        cookie: editorUser.cookie,
        origin: TEST_ORIGIN,
        "content-type": "application/json",
        "if-match": current.headers.get("etag") ?? "",
      },
      body: JSON.stringify({ title: "書き換えた" }),
    });
    expect(response.status).toBe(200);
  });

  test("(D-2) 削除(DELETE)は通る(204)【陰性対照】", async () => {
    const path = `/api/apps/${APP_ID}/tables/silent/records/${silentRowId}`;
    const current = await app.request(path, {
      headers: { cookie: editorUser.cookie, origin: TEST_ORIGIN },
    });
    expect(current.status).toBe(200);
    const response = await app.request(path, {
      method: "DELETE",
      headers: {
        cookie: editorUser.cookie,
        origin: TEST_ORIGIN,
        "if-match": current.headers.get("etag") ?? "",
      },
    });
    expect(response.status).toBe(204);
  });
});
