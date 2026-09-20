/**
 * **`V17-M5-T03d` / 台帳 `AC-G10` / `ADR-0412`**:
 * **親を持たない表(`inherit_from` を1本も宣言していない表)に「行を作れる立場」を
 * 宣言できるようにし、その一覧に挙がっていない役割の作成を断る。**
 *
 * ## 何を測るか(起票 `docs/plan/v16/02-implementation-tasks.md:99` の完了条件の逐語)
 *
 * > **`inherit_from` を持たない表の `access_control` に**新しい1キー(役割名の配列)**を
 * > 宣言したアプリで、そのキーに挙がっていない役割の利用者からの
 * > `POST /api/apps/:app_id/tables/:table_id/records` が **403** になり、挙がっている役割の
 * > 利用者は **201** になり、**そのキーを書いていない表(今日ディスク上の全アプリを含む)
 * > では作成の結果が着手前と1件も変わらない**ことを、本物のサーバに対する HTTP で示すこと。**
 *
 * **実 HTTP で叩く**(`create-parent-write.test.ts` / `batch-create-parent-write.test.ts` と
 * まったく同じ作法)。 **`app.request` は本物の `createServerApp` であり、行は本物の
 * SQLite に書かれる。**
 *
 * | # | 何を撃つか | **着手時(`V17-M5-T03d` が実際に見た)** |
 * | --- | --- | --- |
 * | `(a-1)` | 挙がっていない役割(`viewer`)の作成が断られる | **赤(`201`)** |
 * | `(a-2)` | 挙がっている役割(`editor`)は作れる | 緑(`201`。陰性対照) |
 * | `(a-3)` | **持ち主(`owner`)でも、挙がっていなければ断られる** | **赤(`201`)** |
 * | `(a-4)` | 2つ目の役割を付与表で持つ人(`viewer` ∪ `editor`)は作れる | 緑(`201`。陰性対照) |
 * | `(a-5)` | 断り文に内部記号が1文字も無い | **赤**(断り自体が無い) |
 * | `(b-1)` | **その欄を書いていない表**は今日と1件も変わらない | 緑(`201`。陰性対照) |
 * | `(b-2)` | 権限の宣言を1バイトも持たない表も今日どおり | 緑(`201`。陰性対照) |
 * | `(b-3)` | **まとめ書き(`POST /batch`)の作成にも同じ壁が立つ** | **赤(`200`)** |
 * | `(b-4)` | まとめ書きでも、挙がっている役割は作れる | 緑(陰性対照) |
 * | `(b-5)` | **更新(`PATCH`)には1ミリも掛からない** | 緑(`200`。陰性対照) |
 * | `(c-1)` | 述語: `inherit_from` を宣言した表では素通りする | **赤**(述語が無い) |
 * | `(c-2)` | 述語: `enabled: false` の表では素通りする(**穴**) | **赤**(同上) |
 * | `(c-3)` | 述語: 役割を1つも持たない相手は断られる | **赤**(同上) |
 * | `(d-1)` | **実在しない役割名**を書いた差分が `POST /diffs` で拒否される | 緑(`T03c` が入れた) |
 * | `(d-2)` | **権限名にしか無い綴り**を書いた差分も同じ理由で拒否される | 緑(同上) |
 *
 * **【この検査が測っていないもの。誇張しない】**
 *  - **MCP の口(`apply_diff`)を1度も呼んでいない** —— **それは別プロセスを起こす
 *    実測であり、記録 `m5-t03def.md` §3 に実出力を貼る。**
 *  - **時刻起動・受信口・自動処理・島からの作成を1度も撃っていない** ——
 *    **どれもこの壁を素通りする**(`ADR-0412` 限定7 の射程)。
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

const APP_ID = "root-creatable";

/** 権限名2つ。**`writer` が読み書きを与える**(作成者へ渡す権限名でもある)。 */
const PERMISSIONS = [
  { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
  { id: "writer", name: "編集できる", read: true, write: true, delete: false },
] as const;

/** 親を持たない表の宣言(**`inherit_from` を1本も書かない**)。 */
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
      name: "行を作れる立場",
      tables: [
        {
          // **9キー目を宣言した表。** **`editor` だけが行を作れる。**
          id: "notes",
          name: "記録",
          fields: [{ id: "title", name: "件名", type: "text", required: true }],
          access_control: declaration("note", { creatable_by_roles: ["editor"] }),
        },
        {
          // **9キー目を1文字も書いていない表**(陰性対照)。
          id: "open_notes",
          name: "誰でも作れる記録",
          fields: [{ id: "title", name: "件名", type: "text", required: true }],
          access_control: declaration("open_note"),
        },
        {
          // **権限の宣言を1バイトも持たない表**(陰性対照)。
          id: "plain",
          name: "宣言の無い表",
          fields: [{ id: "title", name: "件名", type: "text", required: true }],
        },
        {
          id: "ac_grant",
          name: "付与",
          fields: [
            { id: "note", name: "記録", type: "reference", reference_table: "notes" },
            {
              id: "open_note",
              name: "誰でも作れる記録",
              type: "reference",
              reference_table: "open_notes",
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
 * **面の規則を足すのは `plain` の1本だけである** —— **足すと
 * `combineRoleAndGrantAccess` の `OR` で面の答えが通り、測りたい壁が測れなくなる。**
 */
function manifestWithRoles(): Manifest {
  const base = manifest();
  return withDefaultRoleRules(base, {
    skipTables: base.app.tables.map((table) => table.id).filter((id) => id !== "plain"),
    skipAllViews: true,
  });
}

let dataRoot = "";
let app: ReturnType<typeof createServerApp>;

/** 9キー目に挙がっている役割の人。 */
let editorUser: ReturnType<typeof seedSession>;
/** 挙がっていない役割の人。 */
let viewerUser: ReturnType<typeof seedSession>;
/** **持ち主。** **挙がっていない。** */
let ownerUser: ReturnType<typeof seedSession>;
/** 列の1値は `viewer` だが、付与表で `editor` も持つ人(**和集合**)。 */
let bothUser: ReturnType<typeof seedSession>;

/** 既に在る行(更新の対照に使う)。 */
let noteId = "";

function withDb<T>(run: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

/** **単件の作成を1回叩く**(**生の応答を返す。報告に貼れる形**)。 */
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

/** **まとめ書きの作成 op 1件**(URL と本文の形だけが単件と違う)。 */
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

/** **定義を書き換える差分を1本投げる**(`POST /diffs`。持ち主だけが叩ける)。 */
async function postDiff(cookie: string, body: unknown): Promise<{ status: number; body: string }> {
  const response = await app.request(`/api/apps/${APP_ID}/diffs`, {
    method: "POST",
    headers: { cookie, origin: TEST_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.text() };
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-rcr-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "行を作れる立場", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, manifestWithRoles()).valid).toBe(true);
  app = createServerApp({ dataRoot });

  editorUser = seedSession(dataRoot, APP_ID, { role: "editor", username: "editor-user" });
  viewerUser = seedSession(dataRoot, APP_ID, { role: "viewer", username: "viewer-user" });
  ownerUser = seedSession(dataRoot, APP_ID, { role: "owner", username: "owner-user" });
  bothUser = seedSession(dataRoot, APP_ID, {
    role: "viewer",
    username: "both-user",
    grants: ["editor"],
  });

  const loaded = manifest();
  withDb((db) => {
    const id = (result: unknown): string => (result as { value: { _id: string } }).value._id;
    const member = (account: string): string =>
      id(createRecord(db, loaded, "ac_member", { account }));
    // **4人とも利用者の表に行を持つ** —— **「登録されていない」の 400 と混ぜないため。**
    member(editorUser.userId);
    const viewerMember = member(viewerUser.userId);
    member(ownerUser.userId);
    member(bothUser.userId);

    noteId = id(createRecord(db, loaded, "notes", { title: "既に在る行" }));
    // **挙がっていない役割の人が、その行を**更新**できる形を作る**(`(b-5)` の材料)。
    expect(
      createRecord(db, loaded, "ac_grant", {
        note: noteId,
        member: viewerMember,
        permission: "writer",
      }).ok,
    ).toBe(true);
  });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (a) 宣言した表 —— 挙がっているかどうかで作れるかが決まる
// ---------------------------------------------------------------------------

describe("V17-M5 (a): 「行を作れる立場」に挙がっている人だけが作れる", () => {
  test("(a-1) 挙がっていない役割の人は作れない(403)", async () => {
    const out = await create("notes", viewerUser.cookie, { title: "作る" });
    expect(out.status).toBe(403);
  });

  test("(a-2) 挙がっている役割の人は作れる(201)【陰性対照】", async () => {
    const out = await create("notes", editorUser.cookie, { title: "作る" });
    expect(out.status).toBe(201);
  });

  test("(a-3) 持ち主(owner)でも、挙がっていなければ作れない(403)【穴として記録する】", async () => {
    // **前提の関門なので運営ロールも迂回しない**(`create-parent-write.test.ts` の
    // `(a-4)` とまったく同じ向きである)。 **【正直に】この形の宣言を書くと、
    // 持ち主自身がその表に1行も作れなくなる。** **それを止める適用時検査は1本も無い。**
    const out = await create("notes", ownerUser.cookie, { title: "作る" });
    expect(out.status).toBe(403);
  });

  test("(a-4) 2つ目の役割を付与表で持つ人は作れる(201。和集合1本)【陰性対照】", async () => {
    const out = await create("notes", bothUser.cookie, { title: "作る" });
    expect(out.status).toBe(201);
  });

  test("(a-5) 断り文に内部記号が1文字も無い", async () => {
    const out = await create("notes", viewerUser.cookie, { title: "作る" });
    expect(out.status).toBe(403);
    for (const symbol of [
      "access_control",
      "creatable_by",
      "creatable_by_roles",
      "inherit_from",
      "creator_permission",
      "notes",
      "editor",
      "viewer",
      "AC-G",
      "ADR-",
    ]) {
      expect({ symbol, leaked: out.body.includes(symbol) }).toEqual({ symbol, leaked: false });
    }
  });
});

// ---------------------------------------------------------------------------
// (b) 掛からないところは今日と1件も変わらない
// ---------------------------------------------------------------------------

describe("V17-M5 (b): その欄を書いていないところは、今日と1件も変わらない", () => {
  test("(b-1) 9キー目を書いていない表は、今はどなたも作れない(403)【`V18-M5` で反転。旧: 挙がっていない役割でも作れる(201)【陰性対照】】", async () => {
    // **【`V18-M5-T02b` / `PM-G2` / `ADR-0442` 授権の表 行14 + 裁定2】**
    // **期待値の**意味を反転**させた2本のうちの1本である**(もう1本は下の `(c-4)`)。
    // **旧(逐語。1バイトも消していない)**:
    //   `test("(b-1) 9キー目を書いていない表は、挙がっていない役割でも作れる(201)【陰性対照】", async () => {`
    //   `  const out = await create("open_notes", viewerUser.cookie, { title: "作る" });`
    //   `  expect(out.status).toBe(201);`
    //   `});`
    // **なぜ題材を足して緑にできないか** —— **この検査の主題そのものが
    // 「9キー目を書いていない表は今日と変わらない」であり、9キー目を書き足すと
    // 主題が消えるからである**(`ADR-0442` §Context 7)。
    const out = await create("open_notes", viewerUser.cookie, { title: "作る" });
    expect(out.status).toBe(403);
  });

  test("(b-2) 権限の宣言を1バイトも持たない表も今日どおり作れる(201)【陰性対照】", async () => {
    // **挙がっていない役割(`owner`)で撃つ** —— **`notes` では 403 になる人が、
    // この表では今日どおり作れることを見る。**
    // **`viewer` で撃たない理由**: **既定の役割の規則が `viewer` に `read` しか
    // 与えないので、この表では**面**が先に 403 にする** —— **本 MS の壁とは別の、
    // 今日すでに在る壁である**(混ぜると測れない)。
    const out = await create("plain", ownerUser.cookie, { title: "作る" });
    expect(out.status).toBe(201);
  });

  test("(b-3) まとめ書きの作成にも同じ壁が立つ(403)", async () => {
    // **まとめ書きは `editor` / `owner` しか叩けない**(認証境界)——
    // **だから挙がっていない側は `owner` で撃つ。**
    const out = await batchCreate("notes", ownerUser.cookie, { title: "作る" });
    expect(out.status).toBe(403);
  });

  test("(b-4) まとめ書きでも、挙がっている役割は作れる【陰性対照】", async () => {
    const out = await batchCreate("notes", editorUser.cookie, { title: "作る" });
    expect(out.status).toBe(200);
  });

  test("(b-5) 更新(PATCH)には1ミリも掛からない(200)【陰性対照】", async () => {
    // **`viewer` はその行に `writer` の付与を持つ** —— **作成は 403 だが更新は通る。**
    // **この壁は作成の枝にしか立っていない**(`ADR-0412` 限定7 の射程)。
    // **版の照合(`If-Match`)は今日も必須である**(`ADR-0017`)—— **付けないと 400 になり、
    // 測りたい 200 / 403 の差が見えない。**
    const path = `/api/apps/${APP_ID}/tables/notes/records/${noteId}`;
    const current = await app.request(path, {
      headers: { cookie: viewerUser.cookie, origin: TEST_ORIGIN },
    });
    expect(current.status).toBe(200);
    const response = await app.request(path, {
      method: "PATCH",
      headers: {
        cookie: viewerUser.cookie,
        origin: TEST_ORIGIN,
        "content-type": "application/json",
        "if-match": current.headers.get("etag") ?? "",
      },
      body: JSON.stringify({ title: "書き換えた" }),
    });
    expect(response.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// (c) 述語そのもの(`owner-scope.ts` の1本)
// ---------------------------------------------------------------------------

describe("V17-M5 (c): 述語が見る範囲", () => {
  /** 手で組んだ定義(**適用しない**。適用時検査が拒否する形も測るため)。 */
  function tableManifest(accessControl: Record<string, unknown>): Manifest {
    return {
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
            access_control: accessControl,
          },
        ],
        views: [],
      },
    } as unknown as Manifest;
  }

  test("(c-1) `inherit_from` を宣言した表では素通りする(根の表専用である)", () => {
    // **この形は適用時に拒否されるので、ディスクの上には現れない**(`T03c` の項目11)。
    // **それでも述語の側で素通りさせておく** —— **2つの壁を重ねない。**
    const blocked = judgeRootCreatableRoles({
      manifest: tableManifest(
        declaration("t", { inherit_from: ["parent"], creatable_by_roles: ["editor"] }),
      ),
      tableId: "t",
      roles: "viewer",
    });
    // **【`V18-M5-T02b` / `ADR-0442` 裁定2】表し方だけの書き換えである。**
    // **旧(逐語)**: `expect(blocked).toBe(false);`
    // **述語の返り値が真偽2値から3語になった**(`ADR-0432` §Decision)。
    // **この検査が主張している事実(引き継ぎを宣言した表では素通りする)は
    // 1ミリも変わっていない。**
    expect(blocked).toBe("allow");
  });

  test("(c-2) `enabled: false` の表では素通りする【穴として記録する】", () => {
    // **【正直に】9キー目を書いても `enabled: false` なら1ミリも効かない。**
    // **それを止める適用時検査は今日1本も無い** —— **「書けるが黙って効かない」形が
    // 1つ残っている。** **【禁止】これを「塞いだ」と読まない。**
    const blocked = judgeRootCreatableRoles({
      manifest: tableManifest(declaration("t", { enabled: false, creatable_by_roles: ["editor"] })),
      tableId: "t",
      roles: "viewer",
    });
    // **【`V18-M5-T02b` / `ADR-0442` 裁定2】表し方だけの書き換えである。**
    // **旧(逐語)**: `expect(blocked).toBe(false);`
    // **`enabled: false` の表では素通りする、という主張は1ミリも変わっていない。**
    expect(blocked).toBe("allow");
  });

  test("(c-3) 役割を1つも持たない相手は断られる", () => {
    const blocked = judgeRootCreatableRoles({
      manifest: tableManifest(declaration("t", { creatable_by_roles: ["editor"] })),
      tableId: "t",
      roles: null,
    });
    // **【`V18-M5-T02b` / `ADR-0442` 裁定2】表し方だけの書き換えである。**
    // **旧(逐語)**: `expect(blocked).toBe(true);`
    // **断られる、という主張は1ミリも変わっていない**(断りの理由が
    // 「一覧に挙がっていない」であることを、3語のうちの1語で名指しするようになった)。
    expect(blocked).toBe("not_listed");
  });

  test("(c-4) 9キー目を書いていない表では断られる【`V18-M5` で反転。旧: 素通りする【陰性対照】】", () => {
    // **【`V18-M5-T02b` / `PM-G2` / `ADR-0442` 授権の表 行14 + 裁定2】**
    // **期待値の**意味を反転**させた2本のうちの1本である**(もう1本は上の `(b-1)`)。
    // **旧(逐語。1バイトも消していない)**:
    //   `test("(c-4) 9キー目を書いていない表では素通りする【陰性対照】", () => {`
    //   `  expect(blocked).toBe(false);`
    // **なぜ題材を足して緑にできないか** —— **この検査の主題そのものが
    // 「9キー目を書いていない表は素通りする」だからである。**
    const blocked = judgeRootCreatableRoles({
      manifest: tableManifest(declaration("t")),
      tableId: "t",
      roles: null,
    });
    expect(blocked).toBe("undeclared");
  });
});

// ---------------------------------------------------------------------------
// (d) 定義を書き換える口(`POST /diffs`)—— **実在しない綴りは差分全体を拒否する**
// ---------------------------------------------------------------------------

describe("V17-M5 (d): 実在しない綴りは HTTP の口でも拒否される", () => {
  function changeTable(creatableByRoles: readonly string[]): unknown {
    return {
      diff_id: `d-rcr-${creatableByRoles.join("-")}`,
      intent: "行を作れる立場を書き換える",
      operations: [
        {
          op: "change_table",
          table: "notes",
          changes: {
            access_control: declaration("note", { creatable_by_roles: [...creatableByRoles] }),
          },
        },
      ],
    };
  }

  test("(d-1) 実在しない役割名を書いた差分は拒否される(`ADR-0412` 限定3 の (i))", async () => {
    const out = await postDiff(ownerUser.cookie, changeTable(["boss"]));
    expect(out.status).toBeGreaterThanOrEqual(400);
    expect(out.body).toContain("boss");
  });

  test("(d-2) 権限名にしか無い綴りを書いた差分も拒否される(同 (ii))", async () => {
    const out = await postDiff(ownerUser.cookie, changeTable(["writer"]));
    expect(out.status).toBeGreaterThanOrEqual(400);
    expect(out.body).toContain("writer");
  });
});
