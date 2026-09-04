/**
 * **`V8-M27-T04` —— 「運営(予約3ロール = `owner` / `editor` / `viewer`)か否か」で
 * 表単位の可否を決めていた古い層を撤去したあとの姿を固定する検査。**
 *
 * 台帳 `T-G5`、ユーザ決定 `D-V8-38` / `D-V8-71` / `D-V8-72` / `D-V8-73`。
 *
 * ## 撤去した層(**旧のふるまいを逐語で残す**)
 *
 * - **`src/server/owner-scope.ts` の `nonAdminTableAccess()` / `NonAdminTableAccess`** ——
 *   **「`st_owner` も `access_control` も `st_public` も持たない表 = 運営テーブル」を
 *   `"denied"` と判定し、非運営の役割の `GET` を 403、書込を 403 にしていた。**
 * - **`src/server/app.ts` の `hasAdminWriteRole()`** —— **実効ロール集合に `editor` /
 *   `owner` が1つも無ければ、レコード書込・まとめ書き込み・ファイルのアップロード・
 *   手動起動を必ず 403 にしていた**(= **`viewer` は何を書いても書けなかった**)。
 *
 * ## 今日の姿
 *
 * **表単位の可否を決めるのは面(`app.roles[].rules`)1本である。**
 * **既定は閉じている**(`V8-M26` / `D-V8-45` / `D-V8-65`)—— **規則を1本も書いていない
 * 表・画面・ボタンは拒否される。** **したがって層を外しても穴は開かない。**
 *
 * ## この検査が固定していないこと(**誇張しない**)
 *
 * - **`owner` 名指しの管理ゲート**(`POST /diffs` / `POST /undo` / `requireOwner` /
 *   初回 owner ブートストラップ)**は撤去していない。** **本ファイルは1バイトも測らない。**
 * - **予約規約フィールド4本**(`st_owner` / `st_public` / `st_undeletable` /
 *   `st_no_direct_create`)**は1バイトも触っていない** —— **役割を1文字も見ない別物である。**
 */

import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN } from "./test-helpers.ts";

const APP_ID = "layer-removal";

/** 仕込みのあいだだけ使う「全部開いた」宣言(段1)。 */
const OPEN_ROLES = [
  {
    id: "owner",
    name: "持ち主",
    rules: [
      // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(適用時検査 = 類型17 の拡張)。
      { target: "app", can: ["write"] },
      { target: "role", can: ["write"] },
      { target: "table", table: "ledger", can: ["read", "write", "delete"] },
      { target: "table", table: "vault", can: ["read", "write", "delete"] },
      { target: "table", table: "album", can: ["read", "write", "delete"] },
      { target: "table", table: "notice", can: ["read", "write", "delete"] },
      { target: "table", table: "wf_runs", can: ["read", "write", "delete"] },
      { target: "view", view: "ledger-list", can: ["read"] },
      { target: "action", view: "ledger-list", action: "bump", can: ["read"] },
    ],
  },
  { id: "editor", name: "編集者" },
  { id: "viewer", name: "閲覧者" },
  { id: "customer", name: "一般利用者" },
];

/**
 * 測るときの宣言(段2)。
 *
 * - **`ledger`** … **旧の「運営テーブル」そのもの**(`st_owner` も `st_public` も
 *   `access_control` も持たない)。**`customer` に読取を、`viewer` に書込を1本ずつ書く。**
 * - **`vault`** … **どの役割も名指ししていない。** **面が止める側を測る土台。**
 * - **`album`** … **`image` 項目を持つ表。** **`owner` にも1本も書いていない** ——
 *   **(e) が「予約3ロールでも規則が無ければファイルが見えない」を測る土台。**
 */
const MEASURE_ROLES = [
  {
    id: "owner",
    name: "持ち主",
    rules: [
      // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(適用時検査 = 類型17 の拡張)。
      { target: "app", can: ["write"] },
      { target: "role", can: ["write"] },
      { target: "table", table: "notice", can: ["read", "write"] },
      { target: "table", table: "wf_runs", can: ["read", "write"] },
    ],
  },
  { id: "editor", name: "編集者" },
  {
    id: "viewer",
    name: "閲覧者",
    rules: [
      // **旧: `hasAdminWriteRole` が `viewer` の書込を必ず 403 にしていた。**
      { target: "table", table: "ledger", can: ["read", "write"] },
      { target: "view", view: "ledger-list", can: ["read"] },
      { target: "action", view: "ledger-list", action: "bump", can: ["read"] },
      { target: "table", table: "notice", can: ["read", "write"] },
      { target: "table", table: "wf_runs", can: ["read", "write"] },
    ],
  },
  {
    id: "customer",
    name: "一般利用者",
    rules: [
      // **旧: `nonAdminTableAccess("ledger") === "denied"` で GET が必ず 403 だった。**
      { target: "table", table: "ledger", can: ["read"] },
      { target: "view", view: "ledger-list", can: ["read"] },
      { target: "action", view: "ledger-list", action: "bump", can: ["read"] },
      { target: "table", table: "notice", can: ["read", "write"] },
      { target: "table", table: "wf_runs", can: ["read", "write"] },
    ],
  },
];

function manifest(roles: unknown[]): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "層を外した店",
      // **【`V8-M29` 第2波】旧(逐語)**: `user_kinds: [{ id: "customer", name: "一般利用者" }],`
      // **語彙 `app.user_kinds` は廃止された** —— **代わりに立つのは `app.roles`
      // (差分操作 `set_roles`)であり、`customer` は `OPEN_ROLES` / `MEASURE_ROLES` の
      // 両方に既に1本立っている**(置き換え先はそこである)。
      tables: [
        {
          id: "ledger",
          name: "台帳",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "memo", name: "覚え書き", type: "text" },
          ],
        },
        {
          id: "vault",
          name: "金庫",
          fields: [{ id: "title", name: "件名", type: "text", required: true }],
        },
        {
          id: "album",
          name: "写真帳",
          fields: [
            { id: "title", name: "件名", type: "text" },
            { id: "photo", name: "写真", type: "image" },
          ],
        },
        { id: "notice", name: "通知", fields: [{ id: "title", name: "件名", type: "text" }] },
        {
          id: "wf_runs",
          name: "実行履歴",
          fields: [
            { id: "ran_at", name: "実行時刻", type: "date" },
            { id: "workflow", name: "ワークフロー", type: "text" },
            { id: "trigger_type", name: "きっかけ", type: "text" },
            { id: "status", name: "結果", type: "text" },
            { id: "error", name: "エラー", type: "long_text" },
          ],
        },
      ],
      views: [
        {
          id: "ledger-list",
          type: "list_view",
          table: "ledger",
          columns: ["title", "memo"],
          actions: [{ id: "bump", run: "bump-wf", name: "押す" }],
        },
      ],
      workflows: [
        {
          id: "bump-wf",
          name: "押す",
          trigger: { type: "manual", table: "ledger" },
          actions: [{ action: "create_record", table: "notice", values: { title: "押された" } }],
          history_table: "wf_runs",
        },
      ],
      roles,
    },
  } as unknown as Manifest;
}

let dataRoot: string | undefined;
let app: ReturnType<typeof createServerApp>;

async function bootOpen(): Promise<void> {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-layer-removal-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "層を外した店", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, manifest(OPEN_ROLES)).valid).toBe(true);
  app = createServerApp({ dataRoot });
}

function reapply(roles: unknown[]): void {
  expect(applyManifest(dataRoot as string, APP_ID, manifest(roles)).valid).toBe(true);
  app = createServerApp({ dataRoot: dataRoot as string });
}

afterEach(async () => {
  if (dataRoot !== undefined) {
    await rm(dataRoot, { recursive: true, force: true });
    dataRoot = undefined;
  }
});

function req(
  cookie: string | undefined,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { origin: TEST_ORIGIN };
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return Promise.resolve(app.request(new Request(`http://localhost${path}`, init)));
}

const records = (table: string) => `/api/apps/${APP_ID}/tables/${table}/records`;

function session(role: "owner" | "editor" | "viewer" | "customer") {
  return seedSession(dataRoot as string, APP_ID, {
    role,
    username: `${role}-${Math.random().toString(36).slice(2, 10)}`,
  });
}

async function create(cookie: string, table: string, values: unknown): Promise<string> {
  const res = await req(cookie, "POST", records(table), values);
  expect(res.status).toBe(201);
  return ((await res.json()) as { record: { _id: string } }).record._id;
}

/** 段1で行を作り、段2の宣言へ差し替える。 */
async function seeded() {
  await bootOpen();
  const owner = session("owner");
  const ledgerId = await create(owner.cookie, "ledger", { title: "台帳1", memo: "運営メモ" });
  const vaultId = await create(owner.cookie, "vault", { title: "金庫1" });
  reapply(MEASURE_ROLES);
  return { owner, ledgerId, vaultId };
}

// =====================================================================================
// (a) 旧「運営テーブル」に、非運営の役割へ読取の規則を1本書けば読める
//     **旧: `nonAdminTableAccess("ledger") === "denied"` で必ず 403 だった。**
// =====================================================================================

test("(a) 旧「運営テーブル」でも、非運営の役割に読取の規則を1本書けば読める(旧: 必ず 403)", async () => {
  const s = await seeded();
  const c = session("customer");
  const res = await req(c.cookie, "GET", records("ledger"));
  // **旧の期待値は `403`(`forbiddenNonAdminReadError`「このテーブルの閲覧は許可されて
  // いません。」)であった。** **今日は 200 で、行がそのまま返る。**
  expect(res.status).toBe(200);
  const body = (await res.json()) as { records: { _id: string }[] };
  expect(body.records.map((row) => row._id)).toEqual([s.ledgerId]);
  // **単件も読める。**
  expect((await req(c.cookie, "GET", `${records("ledger")}/${s.ledgerId}`)).status).toBe(200);
});

// =====================================================================================
// (b) 規則を書かなければ読めない —— **403 ではなく「200 + 0件」/ 単件 404**
//     (`ADR-0305` 限定11 の作法)
// =====================================================================================

test("(b) 規則を1本も書いていない表は読めない(一覧は 200 + 0件・単件は 404。403 にしない)", async () => {
  const s = await seeded();
  for (const who of [session("customer"), session("viewer"), session("owner")]) {
    const list = await req(who.cookie, "GET", records("vault"));
    expect(list.status).toBe(200);
    expect(((await list.json()) as { records: unknown[] }).records).toEqual([]);
    expect((await req(who.cookie, "GET", `${records("vault")}/${s.vaultId}`)).status).toBe(404);
  }
});

// =====================================================================================
// (c) `viewer` に書込の規則を1本書けば書ける
//     **旧: `hasAdminWriteRole` が `viewer` を必ず止めた。**
// =====================================================================================

test("(c) viewer に書込の規則を1本書けば書ける(旧: hasAdminWriteRole が必ず 403)", async () => {
  await seeded();
  const v = session("viewer");
  const res = await req(v.cookie, "POST", records("ledger"), { title: "閲覧者が書いた" });
  // **旧の期待値は `403`(`forbiddenWriteError`「この操作を行う権限がありません(閲覧のみ)。」
  // `allowed_values: ["editor","owner"]`)であった。**
  expect(res.status).toBe(201);
});

test("(c-2) 非運営の役割でも、旧「運営テーブル」に書込の規則が無ければ書けない(403)", async () => {
  await seeded();
  const c = session("customer");
  // `customer` には `ledger` の `read` しか書いていない。
  expect((await req(c.cookie, "POST", records("ledger"), { title: "x" })).status).toBe(403);
});

test("(c-3) まとめ書き込みも viewer が通る(旧: hasAdminWriteRole が必ず 403)", async () => {
  await seeded();
  const v = session("viewer");
  const res = await req(v.cookie, "POST", `/api/apps/${APP_ID}/batch`, {
    ops: [{ op: "create", table: "ledger", values: { title: "まとめ書き" } }],
  });
  expect(res.status).toBe(200);
});

// =====================================================================================
// (d) 手動起動でも同じ
// =====================================================================================

function runUrl(record: string): string {
  return `/api/apps/${APP_ID}/views/ledger-list/actions/run?workflow=bump-wf&record=${record}`;
}

test("(d) 手動起動: viewer も、非運営の役割も、規則が揃っていれば起こせる(旧: どちらも 403)", async () => {
  const s = await seeded();
  // **旧: `viewer` は `hasAdminWriteRole` が false で 403。**
  expect((await req(session("viewer").cookie, "POST", runUrl(s.ledgerId))).status).toBe(200);
  // **旧: 非運営は `nonAdminTableAccess("ledger") !== "scoped"` で 403**
  // (`ledger` は `st_owner` を持たないため、規則を何本書いても届かなかった)。
  expect((await req(session("customer").cookie, "POST", runUrl(s.ledgerId))).status).toBe(200);
});

// =====================================================================================
// (e) ファイル配信
// =====================================================================================

/** `_files` に blob を1件入れ、`album` の行から参照させる。 */
async function seedFile(cookie: string): Promise<{ fileId: string; rowId: string }> {
  const form = new FormData();
  form.set(
    "file",
    new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])]),
    "photo.png",
  );
  const res = await Promise.resolve(
    app.request(
      new Request(`http://localhost/api/apps/${APP_ID}/files`, {
        method: "POST",
        headers: { origin: TEST_ORIGIN, cookie },
        body: form,
      }),
    ),
  );
  expect(res.status).toBe(201);
  const fileId = ((await res.json()) as { file_id: string }).file_id;
  const rowId = await create(cookie, "album", { title: "写真1", photo: fileId });
  return { fileId, rowId };
}

test("(e-1) 予約3ロールでも、その表に読取の規則が無ければファイルは配信されない(404)", async () => {
  await bootOpen();
  const owner = session("owner");
  const { fileId } = await seedFile(owner.cookie);
  // **段2: `album` にはどの役割も1本も書いていない。**
  reapply(MEASURE_ROLES);
  const fresh = session("owner");
  expect((await req(fresh.cookie, "GET", `/api/apps/${APP_ID}/files/${fileId}`)).status).toBe(404);
  expect(
    (await req(session("editor").cookie, "GET", `/api/apps/${APP_ID}/files/${fileId}`)).status,
  ).toBe(404);
});

test("(e-2) 旧「運営テーブル」でも、読取の規則を1本書けば非運営にも配信される", async () => {
  await bootOpen();
  const owner = session("owner");
  const { fileId } = await seedFile(owner.cookie);
  reapply([
    ...MEASURE_ROLES.filter((role) => role.id !== "customer"),
    {
      id: "customer",
      name: "一般利用者",
      rules: [{ target: "table", table: "album", can: ["read"] }],
    },
  ]);
  const c = session("customer");
  expect((await req(c.cookie, "GET", `/api/apps/${APP_ID}/files/${fileId}`)).status).toBe(200);
});

test("(e-3) 定義が読めないときは、誰にも配らない(D-V8-73 = fail-closed)", async () => {
  await bootOpen();
  const owner = session("owner");
  const { fileId } = await seedFile(owner.cookie);
  // **マニフェストを壊す** —— **`loadManifest` が投げる / `ok` でなくなる状態。**
  await writeFile(
    join(dataRoot as string, "apps", APP_ID, "manifest.json"),
    "壊れています",
    "utf8",
  );
  app = createServerApp({ dataRoot: dataRoot as string });
  // **旧: `if (viewer.kind === "anonymous" || !viewer.reservedRole)` の裏返しで、
  // 予約3ロールには 200 で配信していた(自ら「ここは fail-open である」と書いていた)。**
  // **`D-V8-73`(2026-08-11)の選ばれた説明文の逐語**:
  // > 「定義が読めないときは、画像や添付ファイルを誰にも配りません。この軸の
  // >  「書いていなければ見えない」と向きが揃いますが、**定義が壊れたときに運営が
  // >  中身を確かめる手段が1つ減ります**。」
  expect((await req(owner.cookie, "GET", `/api/apps/${APP_ID}/files/${fileId}`)).status).toBe(404);
  expect((await req(undefined, "GET", `/api/apps/${APP_ID}/files/${fileId}`)).status).toBe(404);
});

// =====================================================================================
// (f) `D-V8-72` —— セルフサインアップの予約3ロールの歯止めを撤去したあとの実測
// =====================================================================================

/**
 * **`D-V8-72`(2026-08-11)によって、セルフサインアップ本文の `user_kind` から
 * 「運営ロールを書いたら 422」の歯止めを撤去した。**
 *
 * **選ばれた説明文の逐語**:
 * > 「「人に役割を配れる」を規則で書けるようになってから、そちらで守ります。
 * >  **ただしその仕掛けはまだ入っておらず(次の次の工程)、それまでの間は誰でも
 * >  持ち主として登録できる状態になります。**」
 *
 * ## **【実測。隠さない】撤去しても `user_kind: "owner"` は今日も通らない**
 *
 * **`resolveRequestedUserKind` の拒否条件は2本の `OR` だった** ——
 * **`isReservedRole(value)`(撤去した)と `!allowed.includes(value)`(残っている)。**
 * **`allowed` は `userKindIds(appId)`(= `effectiveUserKindIds`)であり、そちらは
 * `declaredUserKinds` が `isReservedRole` で予約3ロールを**落としてから**返す
 * (`src/server/owner-scope.ts:64`)。** **その `isReservedRole` は本タスクの撤去対象では
 * ない**(「宣言された利用者の種類を読む」側であり、`nonAdminTableAccess` の層ではない)。
 * **したがって `"owner"` は今日も `allowed` に1度も載らず、2本目の条件が 422 にする。**
 *
 * ## **【`V8-M29` 第2波(2026-08-11)。上の4段落は1バイトも消していない】**
 *
 * **`declaredUserKinds` / `effectiveUserKindIds` / `AuthRouteDeps.userKindIds` は撤去された。**
 * **したがって上の「`allowed` は `userKindIds(appId)`(= `effectiveUserKindIds`)」は
 * 今日の正ではない** —— **今日の `allowed` は `signupKindValues(roleIds)` であり、
 * 出所は `app.roles[].id` である。**
 * **それでも `"owner"` が載らないことは変わらない** —— **`signupKindValues` は
 * 予約4語(`owner` / `editor` / `viewer` / `anonymous`)を落としてから返すからである。**
 * **本検査の結論(422 のまま)も `hint` の文面も1文字も変わっていない。**
 *
 * **【禁止の履行】黙って開けていない。** **本検査は「開くはずだった穴が、別の
 * 述語のおかげで今日は開いていない」ことを実 HTTP + 本物の SQLite で固定する。**
 * **これは `V8-M28`(人に役割を配れる規則)が塞ぐ穴の**代わり**ではない** ——
 * **`V8-M28` が `declaredUserKinds` 側の `isReservedRole` にも手を入れるなら、
 * この検査が赤くなって知らせる。**
 *
 * **変わった点は1つだけである**: **エラーの `hint` が「運営のロール(owner / editor /
 * viewer)はこの経路では発行できません。owner に依頼してください。」から、
 * 「アプリが宣言している利用者の種類(user_kinds)のいずれかを指定するか、
 * 省略してください。」に変わった**(分岐そのものを撤去したため)。
 */
test('(f) セルフサインアップに user_kind: "owner" を書いたときの今日の実測(D-V8-72 / V8-M28 の穴)', async () => {
  await bootOpen();
  const res = await req(undefined, "POST", `/api/apps/${APP_ID}/auth/signup/password/register`, {
    username: "self-owner",
    password: "correct horse battery staple",
    user_kind: "owner",
  });
  // **【`V8-M28` が塞ぐ穴。`D-V8-72` によって意図的に開けた歯止めの跡地である】**
  // **開いていれば 201 になり、`_auth_users.role` に `owner` が入る。**
  // **今日は 422 である**(理由は上の doc)。**通ってしまった日は、この検査が
  // 赤くなって知らせる。**
  expect(res.status).toBe(422);
  const body = (await res.json()) as { errors: { hint?: string }[] };
  // **撤去した分岐の hint(「運営のロール…owner に依頼してください。」)はもう出ない。**
  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G12`。メインの裁定2】旧の期待値(逐語)**:
  //     expect(body.errors[0]?.hint).toBe(
  //       "アプリが宣言している利用者の種類(user_kinds)のいずれかを指定するか、省略してください。",
  //     );
  // **`user_kinds` の廃止により、この文面は今日から嘘になった。**
  // **実装の文面を打ち直したので、期待値もその逐語に合わせた。**
  // **測っている線(`user_kind: "owner"` が 422 であること)は1ミリも緩めていない。**
  expect(body.errors[0]?.hint).toBe(
    "アプリが宣言している役割(roles)のうち、持ち主・編集者・閲覧者・未ログインを除いたもののいずれかを指定するか、省略してください。",
  );
  // **DB に `owner` の行が増えていないことも確かめる**(本物の SQLite を直接読む)。
  const db = new Database(join(dataRoot as string, "apps", APP_ID, "app.sqlite"), {
    readonly: true,
  });
  try {
    const rows = db
      .query("SELECT username FROM _auth_users WHERE username = 'self-owner'")
      .all() as unknown[];
    expect(rows).toEqual([]);
  } finally {
    db.close();
  }
});
