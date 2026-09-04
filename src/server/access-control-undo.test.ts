/**
 * **`V7-M5-T04` / `Z-G31`**: **付与の巻き戻し。**
 *
 * **正は `docs/plan/v7/records/v7-m5.md` の `V7-M5-T04` と、`docs/plan/v7/records/v7-m0.md`
 * §6-3 の `Z-G31`(定義の根拠の逐語4本と「実測すること」(a)(b)(c))、および同 §4-5 である。**
 *
 * ## **v7 は巻き戻しの機構を1バイトも変えない**
 *
 * **`src/kernel/undo.ts` / `src/kernel/snapshot.ts` は読むだけで、1バイトも書き換えていない。**
 * **本ファイルは「何が起こるか」を定義して実測するだけである**(`Z-G31` = Δ7 = 門外)。
 *
 * **定義の根拠(`v7-m0.md` §6-3 が引いた逐語。本ファイルは (D-3) / (D-4) / (E-2) / (G) で
 * ソースから引き直す)**:
 *  - `src/kernel/undo.ts` 「…したがって**その apply 以降に追加・編集されたユーザデータも
 *    一緒に消える**。」
 *  - `src/kernel/snapshot.ts` の `restoreSnapshot` は `copyFileSync` で `app.sqlite` と
 *    `manifest.json` を丸ごと上書きする。**行単位の逆操作は1行も無い。**
 *  - `src/auth/types.ts` 「app.sqlite に同居するため、per-app の snapshot/undo で巻き戻る
 *    対象になる…」 —— **`_auth_users` も一緒に戻る。**
 *  - `src/kernel/snapshot.ts` 「…**`apps/<app_id>/blobs/` 配下の画像 blob 実体はコピーしない。
 *    これは意図的な不変条件である。**」
 *
 * ## **測るもの(すべて HTTP の応答で示す。画面で確かめない)**
 *
 * - **(A)** **付与を作った後に `undo` すると、再び見えなくなる**(`Z-G31` の実測 (a))。
 * - **(B)** **付与を消した後に `undo` すると、復活する**(同 (b))。
 *   **【実測の結論】これは `01` §8 の14 が言う「取り消した付与が黙って復活する」に当たる。**
 *   **復活は API から実際に起きる。** **文面は本ファイル冒頭ではなく、記録側の限界に書く。**
 * - **(B')** **付与が消えて行が誰にも見えなくなったとき、`V7-M5-T02` の道
 *   (`GET …/unreachable-records`)でその行を見つけられる。** **`undo` で復活すると
 *   その道から消える。**
 * - **(C)** **`D-V7-25` の一括付与も巻き戻しの対象である。** **2つの面から測る** ——
 *   **(C-1) `change_table` による後からの有効化そのものが `undo` で戻ること /
 *   (C-2) バッチ(`POST /batch`)で一度に作った複数の付与が `undo` で全部戻ること。**
 * - **(D)** **ユーザを消した後に `undo` したときの id の再利用**(同 (c))。
 *   **`V7-M3-T05`(`src/server/access-control-stale-grant.test.ts`)の判定と食い違わないこと。**
 * - **(E)** **`blobs/` はスナップショットに含まれない** —— **巻き戻しの前後で動くのは
 *   判定の入力(付与)だけで、ファイルの実体は1バイトも動かない**(添付ファイルの配信で測る)。
 * - **(F)** **`redo`**。**`undo` の後に `redo` すると付与がどうなるか。**
 *
 * ## **【正直に書く。本ファイルが測っていないこと・できていないこと】**
 *
 *  1. **`ADR-0233` §限界1 は「スナップショット / undo との交差を1度も試していない」と自認した
 *     まま今日に至っている**(`docs/adr/0233-auth-role-check-migration.md`)。**本ファイルが
 *     実測したのは付与(と `_auth_users` の巻き戻し)の側であって、`ADR-0233` の未実測を
 *     1ミリも解くものではない。**
 *  2. **`redo` には HTTP の口が1本も無い**(`src/server/change-routes.ts` が登録するのは
 *     `POST /diffs` / `POST /undo` / `GET /undo/preview` / `GET /changelog` /
 *     `GET /requirements` の5本)。**(F) は状態を動かすところだけカーネルの `redo` を直接
 *     呼び、結果の確認は HTTP で行う。** **「API から示す」を全段で満たせていない唯一の場所
 *     である。**
 *  3. **`D-V7-25` の後半(有効化した瞬間に既存の行へ作成者への付与が1件ずつ自動で入る)は
 *     今日1バイトも実装されていない**(`docs/plan/v7/records/v7-m1.md` の
 *     `V7-M1-T03` (h) の自認)。**(C-1) はその「入らない」ことを実測して固定している** ——
 *     **本ファイルはそれを実装しない。**
 *  4. **MCP / 受信口 / ワークフロー / 島から `undo` を叩く経路を1つも測っていない**
 *     (`Z-G21`〜`Z-G24`)。**MCP の `undo` はカーネル直呼びであり、本ファイルの HTTP とは
 *     別の口である。**
 *  5. **`undo` の同時実行を1度も測っていない。** **`POST /undo` と `POST …/records` が
 *     同時に走ったときに何が起きるかは、本ファイルの外である。**
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore } from "../auth/store.ts";
import {
  appDbPath,
  applyManifest,
  createApp,
  createRecord,
  KernelMetaStore,
  type Manifest,
  redo,
  snapshotDir,
} from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP = "undo-desk";

/** **読むだけ**(`Z-G31` の出口)。**逐語を自分で引くために開く。** */
const SNAPSHOT_SOURCE = readFileSync(
  new URL("../kernel/snapshot.ts", import.meta.url).pathname,
  "utf8",
);
const UNDO_SOURCE = readFileSync(new URL("../kernel/undo.ts", import.meta.url).pathname, "utf8");
const AUTH_TYPES_SOURCE = readFileSync(
  new URL("../auth/types.ts", import.meta.url).pathname,
  "utf8",
);
const AUTH_STORE_SOURCE = readFileSync(
  new URL("../auth/store.ts", import.meta.url).pathname,
  "utf8",
);
const CHANGE_ROUTES_SOURCE = readFileSync(
  new URL("./change-routes.ts", import.meta.url).pathname,
  "utf8",
);

/** **生の応答を報告にそのまま貼るための逃がし口。** 既定では1バイトも出さない。 */
const TRACE = process.env.GP_UNDO_TRACE === "1";

const PERMISSIONS = [
  { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
  { id: "keeper", name: "任せる", read: true, write: true, delete: true },
] as const;

/** `docs` に付ける宣言(**`memos` を後から有効化するときの形もこれに揃える**)。 */
function docsDeclaration(): Record<string, unknown> {
  return {
    enabled: true,
    permissions: [...PERMISSIONS],
    creator_permission: "keeper",
    grant: { table: "doc_grant", target: "doc", member: "member", permission: "permission" },
    members: { table: "doc_member", account: "account" },
  };
}

/** `memos` を後から有効化するときの宣言(`D-V7-25` / `Z-G37`)。 */
function memosDeclaration(): Record<string, unknown> {
  return {
    enabled: true,
    permissions: [...PERMISSIONS],
    creator_permission: "keeper",
    grant: { table: "memo_grant", target: "memo", member: "member", permission: "permission" },
    members: { table: "doc_member", account: "account" },
  };
}

function manifest(): Manifest {
  return {
    app: {
      id: APP,
      name: "巻き戻しの台",
      tables: [
        {
          id: "docs",
          name: "資料",
          fields: [
            { id: "title", name: "題", type: "text", required: true },
            { id: "attachment", name: "添付", type: "file" },
          ],
          access_control: docsDeclaration(),
        },
        {
          // **宣言していない表**(`D-V7-25` = 後からの有効化の測定台)。
          id: "memos",
          name: "覚書",
          fields: [{ id: "body", name: "本文", type: "text" }],
        },
        {
          id: "doc_member",
          name: "利用者",
          fields: [{ id: "account", name: "ログイン", type: "text" }],
        },
        {
          id: "doc_grant",
          name: "資料の付与",
          fields: [
            { id: "doc", name: "資料", type: "reference", reference_table: "docs" },
            { id: "member", name: "相手", type: "reference", reference_table: "doc_member" },
            { id: "permission", name: "権限", type: "select", options: ["reader", "keeper"] },
          ],
        },
        {
          id: "memo_grant",
          name: "覚書の付与",
          fields: [
            { id: "memo", name: "覚書", type: "reference", reference_table: "memos" },
            { id: "member", name: "相手", type: "reference", reference_table: "doc_member" },
            { id: "permission", name: "権限", type: "select", options: ["reader", "keeper"] },
          ],
        },
        {
          // **無害な差分の当て先**(`add_field` で1本足すだけ。判定に1ミリも関わらない)。
          id: "scratch",
          name: "作業メモ",
          fields: [{ id: "note", name: "メモ", type: "text" }],
        },
      ],
      views: [],
    },
  } as unknown as Manifest;
}

/**
 * **【`V8-M26`】面(役割に束ねた権限)の既定が閉じたので、`applyManifest` に渡す題材へ
 * 既定3役割の規則を足したもの。**
 *
 * **足すのは補助表(利用者表 `doc_member` / 付与表 `doc_grant` `memo_grant`)と、
 * 判定に1ミリも関わらない `scratch` だけである。**
 *
 * **`docs` と `memos` には1本も足さない**(`skipTables`)—— **面と点は
 * `combineRoleAndGrantAccess` が `OR` で重ねるので、面を開けると本ファイルが測っている
 * 点(付与の生成・取り消し・巻き戻し)の答えが丸ごと通り、測定が無効になる。**
 *
 * **`memos` を外す理由を名指しで書く** —— **`memos` は題材の時点では
 * `access_control` を1バイトも宣言していないが、(C-1) が `change_table` で**測定の途中に
 * 保護対象へ変える**表である。** **面を開けたままにすると、有効化した瞬間に
 * 「既存の3行が誰からも見えなくなる」(`D-V7-25` の帰結2)が面の `OR` で打ち消され、
 * (C-1-1) / (C-1-2) が測っているものが丸ごと消える。**
 * **その代償として「宣言していないあいだは `editor` に3件そのまま見える」という対照が
 * 成り立たなくなった** —— **期待値を反転させた箇所は各検査に逐語で書いた。**
 *
 * **画面は1つも無い(`views: []`)ので、画面とボタンの規則は1本も入らない。**
 * **`editor` に手書きの規則は1本も足していない** —— **本ファイルの `DELETE` は全部
 * 運営(`owner`)が出しており(`del(...)` の cookie は `admin` 固定)、既定の自動付与が
 * 持ち主へ `delete` を配るからである。**
 */
function manifestWithRoles(): Manifest {
  return withDefaultRoleRules(manifest(), { skipTables: ["docs", "memos"] });
}

let dataRoot = "";
let app: ReturnType<typeof createServerApp>;

/** 運営(`owner`)。**付与を1件も持たない** —— 付与表への書込だけを無条件に通せる。 */
let admin: ReturnType<typeof seedSession>;
let alice: ReturnType<typeof seedSession>;
let bob: ReturnType<typeof seedSession>;
let carol: ReturnType<typeof seedSession>;

let memberOf: Record<"alice" | "bob" | "carol", string>;
/** `docs` の行(**付与は1件も無い状態で作る**)。 */
let docA = "";
let docB = "";
let docC = "";
/** 添付ファイルを持つ行と、その `file_id` / 実体のバイト列。 */
let docFile = "";
let fileId = "";
const FILE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 8, 9]);
/** `memos` の行(宣言していない表)。 */
let memoRows: string[] = [];

function withDb<T>(run: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot, APP), { readwrite: true, create: false });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

type Raw = { status: number; body: string };

function trace(label: string, raw: Raw): Raw {
  if (TRACE) {
    console.log(`[${label}] ${raw.status} ${raw.body}`);
  }
  return raw;
}

async function raw(label: string, response: Response): Promise<Raw> {
  return trace(label, { status: response.status, body: await response.text() });
}

function req(path: string, init?: RequestInit & { cookie?: string }): Request {
  const headers = new Headers(init?.headers);
  if (init?.cookie !== undefined) {
    headers.set("cookie", init.cookie);
  }
  headers.set("origin", TEST_ORIGIN);
  return new Request(`http://localhost${path}`, { ...init, headers });
}

async function get(label: string, path: string, cookie?: string): Promise<Raw> {
  return await raw(label, await app.request(req(path, cookie === undefined ? {} : { cookie })));
}

async function postJson(label: string, path: string, cookie: string, body: unknown): Promise<Raw> {
  return await raw(
    label,
    await app.request(
      req(path, {
        method: "POST",
        cookie,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  );
}

/**
 * **1件消す**(HTTP)。**`If-Match`(楽観ロック。`ADR-0017`)が必須なので、直前に単件 `GET`
 * して版を取り、それを付ける。** **版が取れないときは `GET` の生の応答をそのまま返す。**
 */
async function del(label: string, path: string, cookie: string): Promise<Raw> {
  const current = await app.request(req(path, { cookie }));
  if (current.status !== 200) {
    return trace(label, { status: current.status, body: await current.text() });
  }
  const version = ((await current.json()) as { record: { _updated_at: string } }).record
    ._updated_at;
  return await raw(
    label,
    await app.request(req(path, { method: "DELETE", cookie, headers: { "if-match": version } })),
  );
}

const recordPath = (table: string, id: string): string =>
  `/api/apps/${APP}/tables/${table}/records/${id}`;
const listPath = (table: string): string => `/api/apps/${APP}/tables/${table}/records`;
const doorPath = (table: string): string => `/api/apps/${APP}/tables/${table}/unreachable-records`;

/** **無害な差分を1本当てる**(= この瞬間の `app.sqlite` と `manifest.json` が丸ごと保存される)。 */
let diffSeq = 0;
async function applyHarmlessDiff(label: string): Promise<Raw> {
  diffSeq += 1;
  return await postJson(label, `/api/apps/${APP}/diffs`, admin.cookie, {
    diff_id: `mark-${diffSeq}`,
    intent: "巻き戻しの起点を作るために、作業メモへ列を1本足した",
    operations: [
      {
        op: "add_field",
        table: "scratch",
        field: { id: `note${diffSeq}`, name: "追記", type: "text" },
      },
    ],
  });
}

async function undoOnce(label: string): Promise<Raw> {
  return await raw(
    label,
    await app.request(req(`/api/apps/${APP}/undo`, { method: "POST", cookie: admin.cookie })),
  );
}

/** 付与を1件作る(**HTTP から**。運営ロールは `judgeGrantWrite` の (2) を無条件で通る)。 */
async function grantVia(
  label: string,
  table: "doc_grant" | "memo_grant",
  values: Record<string, unknown>,
): Promise<{ raw: Raw; id: string }> {
  const result = await postJson(label, listPath(table), admin.cookie, values);
  expect(result.status).toBe(201);
  const parsed = JSON.parse(result.body) as { record: { _id: string } };
  return { raw: result, id: parsed.record._id };
}

async function idsOf(path: string, cookie: string): Promise<string[]> {
  const response = await app.request(req(path, { cookie }));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { records?: { _id?: string }[] };
  return (body.records ?? []).map((row) => row._id as string);
}

function grantCount(table: "doc_grant" | "memo_grant"): number {
  return withDb(
    (db) => (db.query(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n,
  );
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-acu-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "巻き戻しの台", { app_id: APP });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP, manifestWithRoles()).valid).toBe(true);
  app = createServerApp({ dataRoot });
  diffSeq = 0;

  // **セッションは「巻き戻しの起点」より手前で作る** —— `_auth_*` も `app.sqlite` に同居して
  // いるので、起点より後で作った cookie は `undo` で消える(§4-5)。
  admin = seedSession(dataRoot, APP, { role: "owner", username: "admin" });
  alice = seedSession(dataRoot, APP, { role: "editor", username: "alice" });
  bob = seedSession(dataRoot, APP, { role: "editor", username: "bob" });
  carol = seedSession(dataRoot, APP, { role: "editor", username: "carol" });

  // 添付ファイルは HTTP からアップロードする(`blobs/` に実体が置かれる)。
  const form = new FormData();
  form.set("file", new Blob([Uint8Array.from(FILE_BYTES)]), "attach.png");
  const uploaded = await app.request(
    new Request(`http://localhost/api/apps/${APP}/files`, {
      method: "POST",
      headers: { cookie: admin.cookie, origin: TEST_ORIGIN },
      body: form,
    }),
  );
  expect(uploaded.status).toBe(201);
  fileId = ((await uploaded.json()) as { file_id: string }).file_id;

  const loaded = manifest();
  memberOf = {} as Record<"alice" | "bob" | "carol", string>;
  memoRows = [];
  withDb((db) => {
    const id = (result: unknown): string => {
      expect((result as { ok: boolean }).ok).toBe(true);
      return (result as { value: { _id: string } }).value._id;
    };
    // **`docs` の行は DB から直接作る** —— HTTP から作ると `D-V7-23` の作成者への自動付与が
    // 1件入ってしまい、「付与が0件の行」を作れない(`V7-M5-T01` の測定台と同じ作法)。
    docA = id(createRecord(db, loaded, "docs", { title: "資料A" }));
    docB = id(createRecord(db, loaded, "docs", { title: "資料B" }));
    docC = id(createRecord(db, loaded, "docs", { title: "資料C" }));
    docFile = id(createRecord(db, loaded, "docs", { title: "添付つき資料", attachment: fileId }));
    for (const name of ["alice", "bob", "carol"] as const) {
      const actor = name === "alice" ? alice : name === "bob" ? bob : carol;
      memberOf[name] = id(createRecord(db, loaded, "doc_member", { account: actor.userId }));
    }
    for (let index = 0; index < 3; index += 1) {
      memoRows.push(id(createRecord(db, loaded, "memos", { body: `覚書${index}` })));
    }
  });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (A) `Z-G31` の実測 (a) —— **付与を作った後に `undo` すると、再び見えなくなる**
// ---------------------------------------------------------------------------

describe("V7-M5-T04 (A): 付与を作った後に巻き戻すと、再び見えなくなる", () => {
  test("(A-1) 付与を作る → 相手から 200 → `undo` → 404", async () => {
    // **起点**(この時点の `app.sqlite` が丸ごと保存される。付与はまだ1件も無い)。
    const mark = await applyHarmlessDiff("A-1 apply");
    expect(mark.status).toBe(201);
    expect(await get("A-1 before", recordPath("docs", docA), alice.cookie)).toMatchObject({
      status: 404,
    });

    const created = await grantVia("A-1 grant", "doc_grant", {
      doc: docA,
      member: memberOf.alice,
      permission: "reader",
    });
    expect(created.id.length).toBeGreaterThan(0);

    const visible = await get("A-1 granted", recordPath("docs", docA), alice.cookie);
    expect(visible.status).toBe(200);
    expect(visible.body).toContain("資料A");

    const undone = await undoOnce("A-1 undo");
    expect(undone.status).toBe(200);

    const gone = await get("A-1 after undo", recordPath("docs", docA), alice.cookie);
    expect(gone.status).toBe(404);
    // **付与行そのものが消えている**(行単位の逆操作ではなく、DB を丸ごと戻した結果)。
    expect(grantCount("doc_grant")).toBe(0);
  });

  test("(A-2) 一覧からも消える(単件だけの話ではない)", async () => {
    expect((await applyHarmlessDiff("A-2 apply")).status).toBe(201);
    await grantVia("A-2 grant", "doc_grant", {
      doc: docA,
      member: memberOf.alice,
      permission: "reader",
    });
    expect(await idsOf(listPath("docs"), alice.cookie)).toEqual([docA]);
    expect((await undoOnce("A-2 undo")).status).toBe(200);
    expect(await idsOf(listPath("docs"), alice.cookie)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (B) `Z-G31` の実測 (b) —— **付与を消した後に `undo` すると、復活する**
// ---------------------------------------------------------------------------

describe("V7-M5-T04 (B): 付与を消した後に巻き戻すと、復活する", () => {
  test("(B-1) 取り消した付与は `undo` で復活し、相手からまた 200 で読める", async () => {
    const created = await grantVia("B-1 grant", "doc_grant", {
      doc: docB,
      member: memberOf.bob,
      permission: "reader",
    });
    expect((await get("B-1 granted", recordPath("docs", docB), bob.cookie)).status).toBe(200);

    // **起点**(この時点のスナップショットには付与行が入っている)。
    expect((await applyHarmlessDiff("B-1 apply")).status).toBe(201);

    const removed = await del("B-1 revoke", recordPath("doc_grant", created.id), admin.cookie);
    expect(removed.status).toBe(204);
    expect((await get("B-1 revoked", recordPath("docs", docB), bob.cookie)).status).toBe(404);
    expect(grantCount("doc_grant")).toBe(0);

    expect((await undoOnce("B-1 undo")).status).toBe(200);

    // **【実測。誇張しない】** **取り消したはずの付与がそのまま効いている。**
    // **`01` §8 の14 が言う「取り消した付与が黙って復活する」に当たる。**
    const revived = await get("B-1 after undo", recordPath("docs", docB), bob.cookie);
    expect(revived.status).toBe(200);
    expect(revived.body).toContain("資料B");
    expect(grantCount("doc_grant")).toBe(1);
  });

  test("(B-2) 復活は画面にも API にも1件の警告を出さない(応答は通常の 200 である)", async () => {
    const created = await grantVia("B-2 grant", "doc_grant", {
      doc: docB,
      member: memberOf.bob,
      permission: "reader",
    });
    expect((await applyHarmlessDiff("B-2 apply")).status).toBe(201);
    expect(
      (await del("B-2 revoke", recordPath("doc_grant", created.id), admin.cookie)).status,
    ).toBe(204);
    const undone = await undoOnce("B-2 undo");
    expect(undone.status).toBe(200);
    // **応答の形は固定の4キーで、「権限が復活した」に当たる欄を1つも持たない。**
    const body = JSON.parse(undone.body) as {
      undo: { entry: { intent: string; kind: string } };
    };
    expect(Object.keys(body.undo).sort()).toEqual([
      "entry",
      "manifest",
      "restored_from",
      "snapshot",
    ]);
    // **`intent` は取り消した差分の文言をそのまま写すだけである** ——
    // **付与が復活したことは1文字も書かれない**(差分は付与を1件も触っていない)。
    expect(body.undo.entry.kind).toBe("undo");
    expect(body.undo.entry.intent).not.toContain("権限");
    expect(body.undo.entry.intent).not.toContain("付与");
    const revived = await get("B-2 after undo", recordPath("docs", docB), bob.cookie);
    expect(revived.status).toBe(200);
    // 応答は通常の単件 GET と同じ形で、警告のキーを1つも持たない。
    expect(Object.keys(JSON.parse(revived.body) as Record<string, unknown>)).toEqual(["record"]);
  });

  test("(B-3) 事前確認(`GET /undo/preview`)は「付与が戻る」ことを名指ししない", async () => {
    const created = await grantVia("B-3 grant", "doc_grant", {
      doc: docB,
      member: memberOf.bob,
      permission: "reader",
    });
    expect((await applyHarmlessDiff("B-3 apply")).status).toBe(201);
    expect(
      (await del("B-3 revoke", recordPath("doc_grant", created.id), admin.cookie)).status,
    ).toBe(204);
    const preview = await get("B-3 preview", `/api/apps/${APP}/undo/preview`);
    expect(preview.status).toBe(200);
    // **表IDと件数は出る**(`doc_grant` が1件戻る)。**「権限」という語は1文字も出ない。**
    expect(preview.body).toContain("doc_grant");
    expect(preview.body).not.toContain("権限");
  });
});

// ---------------------------------------------------------------------------
// (B') `01` §8 の14 の (b) —— **誰にも見えなくなった行を `T02` の道で見つけられる**
// ---------------------------------------------------------------------------

describe("V7-M5-T04 (B'): 付与が消えた行は `unreachable-records` から見つかる", () => {
  test("(B'-1) 付与を消す → 誰にも 404 → 運営はその道で見つけられる → `undo` でその道から消える", async () => {
    const created = await grantVia("B'-1 grant", "doc_grant", {
      doc: docC,
      member: memberOf.carol,
      permission: "reader",
    });
    // **付与が在るうちは、その道に並ばない**(`T02` の (B))。
    const beforeDoor = await get("B'-1 door before", doorPath("docs"), admin.cookie);
    expect(beforeDoor.status).toBe(200);
    expect(JSON.parse(beforeDoor.body)).toMatchObject({ total: 3 });
    expect(await idsOf(doorPath("docs"), admin.cookie)).not.toContain(docC);

    expect((await applyHarmlessDiff("B'-1 apply")).status).toBe(201);
    expect(
      (await del("B'-1 revoke", recordPath("doc_grant", created.id), admin.cookie)).status,
    ).toBe(204);

    // **誰からも 404**(運営ロールからも。`D-V7-22`)。
    expect((await get("B'-1 carol", recordPath("docs", docC), carol.cookie)).status).toBe(404);
    expect((await get("B'-1 admin", recordPath("docs", docC), admin.cookie)).status).toBe(404);

    // **`T02` の道で見つかる。**
    const door = await get("B'-1 door", doorPath("docs"), admin.cookie);
    expect(door.status).toBe(200);
    expect(door.body).toContain(docC);
    expect(await idsOf(doorPath("docs"), admin.cookie)).toContain(docC);

    // **`undo` で付与が戻ると、その道からは消える**(付与が0件でなくなるため)。
    expect((await undoOnce("B'-1 undo")).status).toBe(200);
    expect(await idsOf(doorPath("docs"), admin.cookie)).not.toContain(docC);
    expect((await get("B'-1 carol after", recordPath("docs", docC), carol.cookie)).status).toBe(
      200,
    );
  });

  test("(B'-2) その道は運営専用のままである(`undo` の前後で 403 が変わらない)", async () => {
    expect((await get("B'-2 editor before", doorPath("docs"), alice.cookie)).status).toBe(403);
    expect((await applyHarmlessDiff("B'-2 apply")).status).toBe(201);
    expect((await undoOnce("B'-2 undo")).status).toBe(200);
    expect((await get("B'-2 editor after", doorPath("docs"), alice.cookie)).status).toBe(403);
    expect((await get("B'-2 anon after", doorPath("docs"))).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// (C) `D-V7-25` —— **一括のものも巻き戻しの対象である**
// ---------------------------------------------------------------------------

describe("V7-M5-T04 (C-1): 後からの有効化(`D-V7-25` / `Z-G37`)も巻き戻しの対象である", () => {
  test("(C-1-1) `change_table` で有効化 → 全行が誰にも見えなくなる → `undo` で元どおり見える", async () => {
    // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`。期待値を反転させた。旧文を1バイトも消していない】**
    //
    // **旧のコメント**: 「**有効化の前**: 宣言していない表なので `editor` に3件そのまま見える。」
    // **旧: `expect((await idsOf(listPath("memos"), alice.cookie)).sort()).toEqual([...memoRows].sort());`**
    //
    // **何が変わったか** —— **`V8-M26` が面(役割に束ねた権限)の既定を「閉じる」側へ倒した。**
    // **本ファイルは `memos` を `skipTables` に入れている**(理由は `manifestWithRoles()` の
    // doc に書いた。**(C-1) が測定の途中で `memos` を保護対象へ変えるためである**)。
    // **その結果、`memos` を名指しした面の規則が1本も無く、`editor` の一覧は空で返る。**
    //
    // **【緩めていない。測っているものが1つ減っただけである】** —— **この行は
    // 「宣言していない表は素通りする」という**対照**であって、(C-1-1) の主題
    // (**有効化した瞬間に既存の行が誰からも見えなくなり、`undo` で戻る**)ではない。**
    // **主題は下の 617 / 618 行と 625 行が今日も測っている。**
    expect(await idsOf(listPath("memos"), alice.cookie)).toEqual([]);

    const enabled = await postJson("C-1 enable", `/api/apps/${APP}/diffs`, admin.cookie, {
      diff_id: "enable-memos",
      intent: "すでに使っている覚書の表に、あとからアクセス権管理を有効にした",
      operations: [
        { op: "change_table", table: "memos", changes: { access_control: memosDeclaration() } },
      ],
    });
    expect(enabled.status).toBe(201);

    // **【実測。`D-V7-25` の後半は今日1件も実装されていない】** ——
    // **有効化した瞬間に「既存の行へ作成者への付与が1件ずつ自動で入る」ことは起きない。**
    expect(grantCount("memo_grant")).toBe(0);
    // **その結果、既存の3行はこの瞬間に誰からも見えなくなる。**
    expect(await idsOf(listPath("memos"), alice.cookie)).toEqual([]);
    expect(await idsOf(listPath("memos"), admin.cookie)).toEqual([]);
    const door = await get("C-1 door", doorPath("memos"), admin.cookie);
    expect(door.status).toBe(200);
    expect(JSON.parse(door.body)).toMatchObject({ total: 3 });

    // **巻き戻すと宣言ごと戻る**(`manifest.json` も `copyFileSync` で丸ごと戻るため)。
    expect((await undoOnce("C-1 undo")).status).toBe(200);
    // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`。期待値を反転させた。旧文を1バイトも消していない】**
    //
    // **旧: `expect((await idsOf(listPath("memos"), alice.cookie)).sort()).toEqual([...memoRows].sort());`**
    //
    // **巻き戻しで `access_control` の宣言そのものは今日も戻っている**(すぐ下の道の 404 が
    // それを示す)。**しかし `memos` は面の規則を1本も持たない**(`skipTables`)**ので、
    // 点が管轄外に戻った今、面の閉じた既定がそのまま答えになり、`editor` には1件も見えない。**
    //
    // **【正直に書く。テスト名の「元どおり見える」は今日は半分しか成り立たない】** ——
    // **元どおりになるのは**宣言**(点の管轄)であって、**見え方**ではない。**
    // **見え方が戻らない理由は巻き戻しの側ではなく、面の既定が閉じたことの側にある。**
    expect(await idsOf(listPath("memos"), alice.cookie)).toEqual([]);
    // **【`V8-M41` / 台帳 `F-G13`。2026-08-13。期待値を反転させた。旧の2行を1バイトも
    //   消していない】**
    //
    // **旧のコメント**: 「**宣言が消えたので、その道も 404 に戻る**(オプトイン)。」
    // **旧: `expect((await get("C-1 door after", doorPath("memos"), admin.cookie)).status).toBe(404);`**
    //
    // **宣言(点の管轄)が消えたことは今日も同じである。** **変わったのは、点が管轄外の表でも
    // この口が**面の側**の取り残しを拾うようになったことである**(`v8-m33.md` §12 の `D-13`)。
    // **`memos` は面の規則を1本も持たない**(`skipTables`)**ので、巻き戻した3行はどの役割からも
    // 読めない** —— **すぐ上の1行(`editor` には1件も見えない)と同じ事実の裏側である。**
    // **つまりこの口は今日、「見え方が戻らなかった行」を運営に見せる。**
    const doorAfter = await get("C-1 door after", doorPath("memos"), admin.cookie);
    expect(doorAfter.status).toBe(200);
    expect(
      (JSON.parse(doorAfter.body) as { records: { _id: string }[] }).records
        .map((row) => row._id)
        .sort(),
    ).toEqual([...memoRows].sort());
  });

  test("(C-1-2) 有効化のあとに一括で付けた付与も、有効化ごと `undo` で戻る", async () => {
    expect(
      (
        await postJson("C-1-2 enable", `/api/apps/${APP}/diffs`, admin.cookie, {
          diff_id: "enable-memos-2",
          intent: "覚書の表にアクセス権管理を有効にした",
          operations: [
            { op: "change_table", table: "memos", changes: { access_control: memosDeclaration() } },
          ],
        })
      ).status,
    ).toBe(201);

    // **有効化のあとに、取り残しの3行へ一括で付与を入れる**(`D-V7-25` の帰結2 の手当を人手で行う形)。
    const batch = await postJson("C-1-2 batch", `/api/apps/${APP}/batch`, admin.cookie, {
      ops: memoRows.map((memoId) => ({
        op: "create",
        table: "memo_grant",
        values: { memo: memoId, member: memberOf.alice, permission: "reader" },
      })),
    });
    expect(batch.status).toBe(200);
    expect(grantCount("memo_grant")).toBe(3);
    expect((await idsOf(listPath("memos"), alice.cookie)).sort()).toEqual([...memoRows].sort());

    // **`undo` は有効化の差分を戻す** —— **その後に入れた付与3件も一緒に消える。**
    expect((await undoOnce("C-1-2 undo")).status).toBe(200);
    expect(grantCount("memo_grant")).toBe(0);
    // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`。期待値を反転させた。旧文を1バイトも消していない】**
    //
    // **旧のコメント**: 「宣言が消えているので、3行は宣言していない表として今日どおり見える。」
    // **旧: `expect((await idsOf(listPath("memos"), alice.cookie)).sort()).toEqual([...memoRows].sort());`**
    //
    // **宣言も付与も巻き戻しで消えている**(直前の `grantCount` が0を示す)。**点が管轄外に
    // 戻った結果、答えを決めるのは面だけになり、`memos` を名指しした規則が1本も無いので
    // 閉じる。** **本検査の主題(**一括で入れた付与3件が `undo` で全部消える**)は、直前の
    // `grantCount("memo_grant")` が今日も測っている。**
    expect(await idsOf(listPath("memos"), alice.cookie)).toEqual([]);
  });
});

describe("V7-M5-T04 (C-2): 一括で作った複数の付与が `undo` で全部戻る", () => {
  test("(C-2-1) バッチで3件の付与を作る → 3人が 200 → `undo` → 3人とも 404 で付与0件", async () => {
    expect((await applyHarmlessDiff("C-2 apply")).status).toBe(201);

    const batch = await postJson("C-2 batch", `/api/apps/${APP}/batch`, admin.cookie, {
      ops: [
        {
          op: "create",
          table: "doc_grant",
          values: { doc: docA, member: memberOf.alice, permission: "reader" },
        },
        {
          op: "create",
          table: "doc_grant",
          values: { doc: docB, member: memberOf.bob, permission: "reader" },
        },
        {
          op: "create",
          table: "doc_grant",
          values: { doc: docC, member: memberOf.carol, permission: "keeper" },
        },
      ],
    });
    expect(batch.status).toBe(200);
    expect(grantCount("doc_grant")).toBe(3);

    expect(await idsOf(listPath("docs"), alice.cookie)).toEqual([docA]);
    expect(await idsOf(listPath("docs"), bob.cookie)).toEqual([docB]);
    expect(await idsOf(listPath("docs"), carol.cookie)).toEqual([docC]);

    expect((await undoOnce("C-2 undo")).status).toBe(200);

    expect(grantCount("doc_grant")).toBe(0);
    expect((await get("C-2 alice", recordPath("docs", docA), alice.cookie)).status).toBe(404);
    expect((await get("C-2 bob", recordPath("docs", docB), bob.cookie)).status).toBe(404);
    expect((await get("C-2 carol", recordPath("docs", docC), carol.cookie)).status).toBe(404);
    // **4件とも取り残し一覧に戻る**(添付つきの行を含む)。
    const door = await get("C-2 door", doorPath("docs"), admin.cookie);
    expect(JSON.parse(door.body)).toMatchObject({ total: 4 });
  });
});

// ---------------------------------------------------------------------------
// (D) `Z-G31` の実測 (c) —— **ユーザを消した後の `undo` と id の再利用**
// ---------------------------------------------------------------------------

describe("V7-M5-T04 (D): ユーザを消した後に巻き戻したときの id", () => {
  test("(D-1) 消したユーザは `undo` で同じ id のまま戻り、その人の付与がまた効く", async () => {
    await grantVia("D-1 grant", "doc_grant", {
      doc: docA,
      member: memberOf.alice,
      permission: "reader",
    });
    expect((await get("D-1 before", recordPath("docs", docA), alice.cookie)).status).toBe(200);

    // **起点**(この時点の `_auth_users` / `_auth_sessions` も丸ごと保存される)。
    expect((await applyHarmlessDiff("D-1 apply")).status).toBe(201);

    const store = AuthStore.openForApp(dataRoot, APP);
    try {
      store.deleteUser(alice.userId);
      expect(store.findUserById(alice.userId)).toBeUndefined();
    } finally {
      store.close();
    }
    // **`V7-M3-T05` (D-4) と同じ形** —— **付与行もメンバー行も1件も消えない。**
    expect(grantCount("doc_grant")).toBe(1);
    // **セッションが消えるので、その cookie は認証を1度も通らない(404 ではなく 401)。**
    expect((await get("D-1 deleted", recordPath("docs", docA), alice.cookie)).status).toBe(401);

    expect((await undoOnce("D-1 undo")).status).toBe(200);

    // **同じ id のユーザが戻る**(= 別人に id が振り直されたのではない)。
    const after = AuthStore.openForApp(dataRoot, APP);
    try {
      const restored = after.findUserById(alice.userId);
      expect(restored?.id).toBe(alice.userId);
      expect(restored?.username).toBe(alice.username);
    } finally {
      after.close();
    }
    // **セッションも戻るので、同じ cookie がまた通り、付与がまた効く。**
    const revived = await get("D-1 after undo", recordPath("docs", docA), alice.cookie);
    expect(revived.status).toBe(200);
    expect(revived.body).toContain("資料A");
  });

  test("(D-2) `Z-G32` の判定と食い違わない —— 巻き戻しは id の再利用ではない", async () => {
    expect((await applyHarmlessDiff("D-2 apply")).status).toBe(201);
    const store = AuthStore.openForApp(dataRoot, APP);
    let newcomerId = "";
    try {
      store.deleteUser(alice.userId);
      // **消えた直後に新しい人を作っても、id は1度も再利用されない。**
      newcomerId = store.createUser({ username: "newcomer", role: "editor" }).id;
      expect(newcomerId).not.toBe(alice.userId);
    } finally {
      store.close();
    }
    expect((await undoOnce("D-2 undo")).status).toBe(200);
    // **巻き戻しの後、`undo` の起点より後に作った人は居ない**(丸ごと戻ったため)。
    const after = AuthStore.openForApp(dataRoot, APP);
    try {
      expect(after.findUserById(newcomerId)).toBeUndefined();
      expect(after.findUserById(alice.userId)?.id).toBe(alice.userId);
    } finally {
      after.close();
    }
  });

  test("(D-3) `_auth_users` の DDL に連番も `AUTOINCREMENT` も無い(`Z-G32` 限定3 の逐語を引き直す)", () => {
    const start = AUTH_STORE_SOURCE.indexOf("const AUTH_USERS_COLUMNS_DDL = `");
    expect(start).toBeGreaterThan(-1);
    const ddl = AUTH_STORE_SOURCE.slice(start, start + 400);
    expect(ddl.includes("AUTOINCREMENT")).toBe(false);
    expect(/INTEGER\s+PRIMARY\s+KEY/i.test(ddl)).toBe(false);
    // **id は 256bit の暗号乱数である。**【禁止】「衝突しない」とは書かない。
    expect(AUTH_STORE_SOURCE).toContain("暗号乱数 32byte(256bit)を base64url にした不透明 ID。");
  });

  test("(D-4) `_auth_*` が `app.sqlite` に同居することの逐語(`v7-m0.md` §4-5 の根拠)", () => {
    expect(AUTH_TYPES_SOURCE).toContain(
      "app.sqlite に同居するため、per-app の snapshot/undo で巻き戻る対象になる",
    );
  });
});

// ---------------------------------------------------------------------------
// (E) `blobs/` はスナップショットに含まれない —— **動くのは判定の入力(付与)だけ**
// ---------------------------------------------------------------------------

describe("V7-M5-T04 (E): 添付ファイルの実体は巻き戻しで1バイトも動かない", () => {
  test("(E-1) 付与を消して `undo` すると、配信は 200 → 404 → 200 に戻り、中身は同一である", async () => {
    const created = await grantVia("E-1 grant", "doc_grant", {
      doc: docFile,
      member: memberOf.bob,
      permission: "reader",
    });
    const filePath = `/api/apps/${APP}/files/${fileId}`;

    const before = await app.request(req(filePath, { cookie: bob.cookie }));
    expect(before.status).toBe(200);
    const beforeBytes = new Uint8Array(await before.arrayBuffer());
    expect([...beforeBytes]).toEqual([...FILE_BYTES]);

    expect((await applyHarmlessDiff("E-1 apply")).status).toBe(201);
    expect(
      (await del("E-1 revoke", recordPath("doc_grant", created.id), admin.cookie)).status,
    ).toBe(204);
    // **判定の入力(付与)が消えた瞬間、file も渡らなくなる**(`Z-G36` / `V7-M3-T07`)。
    expect((await get("E-1 revoked", filePath, bob.cookie)).status).toBe(404);

    expect((await undoOnce("E-1 undo")).status).toBe(200);

    const after = await app.request(req(filePath, { cookie: bob.cookie }));
    expect(after.status).toBe(200);
    const afterBytes = new Uint8Array(await after.arrayBuffer());
    // **実体は1バイトも動いていない。** **動いたのは付与だけである。**
    expect([...afterBytes]).toEqual([...beforeBytes]);
  });

  test("(E-2) スナップショットの中に `blobs/` は1つも無い(逐語つき)", async () => {
    expect((await applyHarmlessDiff("E-2 apply")).status).toBe(201);
    const snapshots = readdirSync(join(dataRoot, "apps", APP, "snapshots"));
    expect(snapshots.length).toBeGreaterThan(0);
    for (const name of snapshots) {
      const dir = snapshotDir(dataRoot, APP, name);
      expect(readdirSync(dir).sort()).toEqual(["app.sqlite", "manifest.json"]);
      expect(existsSync(join(dir, "blobs"))).toBe(false);
    }
    // **`v7-m0.md` §6-3 が引いた逐語を、本ファイルが自分で引き直す。**
    expect(SNAPSHOT_SOURCE).toContain(
      "`apps/<app_id>/blobs/` 配下の画像 blob 実体はコピーしない。これは意図的な不変条件である。",
    );
  });
});

// ---------------------------------------------------------------------------
// (F) `redo` —— **`undo` のあと `redo` すると付与がどうなるか**
// ---------------------------------------------------------------------------

describe("V7-M5-T04 (F): `redo`", () => {
  test("(F-1) 復活した付与は `redo` でもう一度消える(往復する)", async () => {
    const created = await grantVia("F-1 grant", "doc_grant", {
      doc: docB,
      member: memberOf.bob,
      permission: "reader",
    });
    expect((await applyHarmlessDiff("F-1 apply")).status).toBe(201);
    expect(
      (await del("F-1 revoke", recordPath("doc_grant", created.id), admin.cookie)).status,
    ).toBe(204);
    expect((await get("F-1 revoked", recordPath("docs", docB), bob.cookie)).status).toBe(404);

    expect((await undoOnce("F-1 undo")).status).toBe(200);
    expect((await get("F-1 after undo", recordPath("docs", docB), bob.cookie)).status).toBe(200);

    // **`redo` には HTTP の口が1本も無い**((F-2) が固定する)。**状態を動かすところだけ
    // カーネルを直接呼び、結果の確認は HTTP で行う。**
    const done = redo(dataRoot, APP);
    expect(done.valid).toBe(true);

    // **`redo` は「`undo` を実行する直前の状態」を書き戻す** —— **付与を消した後の状態である。**
    expect((await get("F-1 after redo", recordPath("docs", docB), bob.cookie)).status).toBe(404);
    expect(grantCount("doc_grant")).toBe(0);
    // **その行は取り残し一覧に戻る。**
    expect(await idsOf(doorPath("docs"), admin.cookie)).toContain(docB);
  });

  test("(F-2) `redo` には HTTP の口が1本も無い(登録されているのは5本)", async () => {
    // ソース上の登録:`POST /diffs` / `POST /undo` / `GET /undo/preview` / `GET /changelog` /
    // `GET /requirements`。**`redo` の綴りは1度も現れない。**
    expect(CHANGE_ROUTES_SOURCE).not.toContain('"/api/apps/:app_id/redo"');
    const notFound = await app.request(
      req(`/api/apps/${APP}/redo`, { method: "POST", cookie: admin.cookie }),
    );
    expect(
      trace("F-2 redo route", { status: notFound.status, body: await notFound.text() }).status,
    ).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// (G) 定義の根拠 —— **`Z-G31` が引いた逐語を自分で引き直し、機構を触っていないことを固定する**
// ---------------------------------------------------------------------------

describe("V7-M5-T04 (G): 定義の根拠と、機構を1バイトも変えていないこと", () => {
  test("(G-1) `undo` は「apply 以降のユーザデータも一緒に消える」と自分で書いている", () => {
    expect(UNDO_SOURCE).toContain(
      "したがって**その apply 以降に追加・編集されたユーザデータも一緒に消える**",
    );
  });

  test("(G-2) `restoreSnapshot` は `copyFileSync` で丸ごと上書きする(行単位の逆操作は1行も無い)", () => {
    const start = SNAPSHOT_SOURCE.indexOf("export function restoreSnapshot(");
    expect(start).toBeGreaterThan(-1);
    const body = SNAPSHOT_SOURCE.slice(start, SNAPSHOT_SOURCE.indexOf("\n}", start));
    expect(body).toContain("copyFileSync(sourceDb, dbPath);");
    expect(body).toContain("copyFileSync(sourceManifest, appManifestPath(dataRoot, appId));");
    expect(body).not.toContain("DELETE FROM");
    expect(body).not.toContain("INSERT INTO");
  });

  test("(G-3) `undo.ts` / `snapshot.ts` に v7 の語が1つも入っていない(読むだけである)", () => {
    for (const source of [UNDO_SOURCE, SNAPSHOT_SOURCE]) {
      expect(source).not.toContain("access_control");
      expect(source).not.toContain("judgeRecordAccess");
      expect(source).not.toContain("Z-G31");
    }
  });
});
