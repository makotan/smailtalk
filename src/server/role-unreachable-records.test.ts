/**
 * **`V8-M41` / 台帳 `F-G13`**: **規則ゼロで誰にも届かなくなった行を、運営専用の逃げ道が拾う。**
 *
 * **正は `docs/plan/v8/records/v8-m35.md` §5-1 の `F-G13` の行の限定(逐語)である**:
 * 「**運営専用の口だけを広げる。** **一般の一覧・単件の伏せ方(`ADR-0317` 限定5)を
 * 1バイトも動かさない**」。
 *
 * ## 何が今日まで欠けていたか(**着手前の実測**)
 *
 * **`v8-m33.md` §12 の `D-13` の逐語**: 「**`diaries` には行が1行実在するのに 404 を返す。**
 * **この口が拾うのは `access_control` を宣言した表だけである**」。
 * **`cp-v8-unify.md` §20-D の 4 が同じものを本物の HTTP で再現している。**
 *
 * **原因は1行である** —— **`recordAccessSourceTables(manifest, tableId)` が `undefined` を
 * 返したら 404 にしていた**(`src/server/app.ts`)。**その `undefined` は「宣言していない表」
 * という意味であって、「取り残しが在りえない表」という意味ではない。**
 * **面(役割の規則)の既定が閉じた今日(`V8-M26` / `D-V8-45`)、規則を1本も書かれていない表の
 * 行は誰からも読めない** —— **その行がまさに「誰にも届かない行」である。**
 *
 * ## 測るもの
 *
 * - **(A)** **規則ゼロの表**: **口が 200 を返し、並ぶ `_id` が生の SQLite の `_id` と一致する。**
 * - **(B)** **伏せ方を1バイトも動かしていない**: **同じ表の一覧 `GET` は今日も
 *   `{"records":[],"total":0}` の 200 / 単件 `GET` は今日も 404 / `owner` 以外は 403。**
 * - **(C)** **誰か1人でも読める行は1件も並ばない**(**取り残しではないため**)——
 *   **全役割が読める表でも、1つの役割だけが読める表でも並ばない。**
 * - **(D)** **条件(`when`)つきの規則しか無い行は並ばない**(**断定できないので伏せる**。
 *   **これは限界であって設計上の完全さではない。下の「測って『できていない』ことを記録する
 *   もの」に書く**)。
 * - **(E)** **`access_control` を宣言した表の挙動が1バイトも変わっていない。**
 * - **(F)** **404 が残る条件**: **実在しない表**と、**システムが持つ表**の2つだけである。
 * - **(G)** **述語そのもの**(`resolveRecordUnreachableByRoles`)の単体。
 *
 * ## 測って「できていない」ことを記録するもの(**誇張しない**)
 *
 * - **(D-2)** **条件つきの規則で閉じた行は、誰にも読めなくてもこの口に並ばない。**
 *   **理由は「誰が要求しているか」を伏せて判定しているためである** ——
 *   **`{field, equals_current_user}` の葉は主体が決まらないと評価できず、行の持ち主本人には
 *   読めるかもしれない。** **その行を並べると「他人には見えている行」を運営に見せることに
 *   なりうるので、**並べない側**に倒した**(`record-access-orphans.test.ts` の (Y-1) と同じ向き)。
 * - **この口は「運営が回復できる」ことを1ミリも意味しない** —— **並んだ行に規則を足す手段を
 *   1つも増やしていない**(`Z-G19` の「誇張しない」の逐語をそのまま引き継ぐ)。
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
import { resolveRecordUnreachableByRoles } from "./owner-scope.ts";
import { seedSession } from "./test-helpers.ts";

const APP_ID = "sealed-desk";

const DOOR = (tableId: string): string =>
  `/api/apps/${APP_ID}/tables/${tableId}/unreachable-records`;
const RECORDS = (tableId: string): string => `/api/apps/${APP_ID}/tables/${tableId}/records`;

const PERMISSIONS = [
  { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
  { id: "writer", name: "編集できる", read: true, write: true, delete: false },
] as const;

/** 表1本ぶんの規則(条件を書かない形)。 */
function rule(table: string, can: readonly string[]): Record<string, unknown> {
  return { target: "table", table, can: [...can] };
}

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "規則ゼロの台帳",
      roles: [
        {
          id: "owner",
          name: "持ち主",
          // **持ち主にはこの2行が必ず要る**(`V8-M28` / 適用時検査の類型17 の拡張)。
          rules: [
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
            // **`sealed` を1本も名指ししない** —— **これが「規則ゼロ」の作り方である。**
            rule("open_notes", ["read", "write", "delete"]),
            rule("armed", ["read", "write", "delete"]),
            rule("armed_member", ["read", "write", "delete"]),
            rule("armed_grant", ["read", "write", "delete"]),
          ],
        },
        {
          id: "editor",
          name: "編集者",
          rules: [
            rule("open_notes", ["read", "write"]),
            // **条件つきの規則しか無い表**((D))。**`kind` が `"open"` の行だけ読める。**
            {
              target: "table",
              table: "conditional",
              can: ["read"],
              when: { field: "kind", equals: "open" },
            },
          ],
        },
        {
          id: "viewer",
          name: "閲覧者",
          // **1つの役割だけが読める表**((C-2))。
          rules: [rule("open_notes", ["read"]), rule("one_reader", ["read"])],
        },
      ],
      tables: [
        {
          // **規則ゼロの表**(`v8-m33.md` §12 の `D-13` の `diaries` 相当)。
          id: "sealed",
          name: "誰も名指ししない表",
          fields: [{ id: "body", name: "本文", type: "text" }],
        },
        {
          // **全役割が読める表**((C-1) の対照)。
          id: "open_notes",
          name: "開いている表",
          fields: [{ id: "body", name: "本文", type: "text" }],
        },
        {
          // **1つの役割(`viewer`)だけが読める表**((C-2))。
          id: "one_reader",
          name: "1人だけ読める表",
          fields: [{ id: "body", name: "本文", type: "text" }],
        },
        {
          // **条件つきの規則しか無い表**((D))。
          id: "conditional",
          name: "条件つきの表",
          fields: [
            { id: "body", name: "本文", type: "text" },
            { id: "kind", name: "種別", type: "text" },
          ],
        },
        {
          // **`access_control` を宣言した表**((E) の対照。**着手前と1バイトも同じであること**)。
          id: "armed",
          name: "宣言した表",
          fields: [{ id: "title", name: "題", type: "text", required: true }],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "writer",
            grant: {
              table: "armed_grant",
              target: "armed",
              member: "member",
              permission: "permission",
            },
            members: { table: "armed_member", account: "account" },
          },
        },
        {
          id: "armed_member",
          name: "利用者",
          fields: [{ id: "account", name: "口座", type: "text" }],
        },
        {
          id: "armed_grant",
          name: "付与",
          fields: [
            { id: "armed", name: "行", type: "reference", reference_table: "armed" },
            { id: "member", name: "相手", type: "reference", reference_table: "armed_member" },
            { id: "permission", name: "権限", type: "select", options: ["reader", "writer"] },
          ],
        },
      ],
      views: [],
    },
  } as unknown as Manifest;
}

let dataRoot = "";
let app: ReturnType<typeof createServerApp>;
let owner: ReturnType<typeof seedSession>;
let viewer: ReturnType<typeof seedSession>;
/** `sealed` に入れた2行(生の `_id`。**SQLite から読み直して突き合わせる**)。 */
let sealedIds: string[] = [];
let openNoteId = "";
let oneReaderId = "";
let conditionalOpenId = "";
let conditionalClosedId = "";
let armedIds: string[] = [];

function withDb<T>(run: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

/** **生の SQLite から `_id` を読む**(応答と突き合わせる側の値)。 */
function rawIds(tableId: string): string[] {
  return withDb((db) =>
    (db.query(`SELECT "_id" FROM "${tableId}" ORDER BY rowid`).all() as { _id: string }[]).map(
      (row) => row._id,
    ),
  );
}

async function raw(path: string, cookie?: string): Promise<{ status: number; body: string }> {
  const response = await app.request(
    `http://localhost${path}`,
    cookie === undefined ? {} : { headers: { cookie } },
  );
  return { status: response.status, body: await response.text() };
}

async function listedIds(path: string, cookie: string): Promise<{ ids: string[]; total: number }> {
  const response = await raw(path, cookie);
  expect(response.status, response.body).toBe(200);
  const body = JSON.parse(response.body) as { records: { _id: string }[]; total: number };
  return { ids: body.records.map((row) => row._id), total: body.total };
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-sealed-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "規則ゼロの台帳", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, manifest()).valid).toBe(true);
  app = createServerApp({ dataRoot });
  owner = seedSession(dataRoot, APP_ID, { role: "owner", username: "u-owner" });
  viewer = seedSession(dataRoot, APP_ID, { role: "viewer", username: "u-viewer" });

  const loaded = manifest();
  const insert = (tableId: string, values: Record<string, unknown>): string =>
    withDb((db) => {
      const created = createRecord(db, loaded, tableId, values);
      expect(created.ok, JSON.stringify(created)).toBe(true);
      return (created as { value: { _id: string } }).value._id;
    });

  sealedIds = [
    insert("sealed", { body: "誰にも届かない1" }),
    insert("sealed", { body: "誰にも届かない2" }),
  ];
  // ---------------------------------------------------------------------------
  // **【`V8-M5-T08`。着手前(`ae8edd6`)から在る不安定の是正であって、本軸の成果ではない】**
  //
  // この口が返す並びは一覧の既定順(`src/kernel/records.ts` の
  // 「作られた時刻 ASC, `_id` ASC」)である。**2行が同じミリ秒に書かれると先頭のキーが
  // 同着になり、並びはランダムな UUID(`_id`)で決まる** —— **生の SQLite の rowid 順
  // (= 書き込み順)と入れ替わり、(A-1) / (A-2) が不定期に落ちる。**
  //
  // **期待値は緩めない** —— **(A-1) は今日も「応答の並びが rowid 順と一致すること」を問う。**
  // **読み方を決定的にする**: **同着そのものを消して、既定順が書き込み順と1対1になるようにする。**
  // 先例: `src/mcp/tools/write.test.ts` の `insertionOrderVia`(同着はランダムな UUID 順になる、
  // という同型の実測がある)。
  // ---------------------------------------------------------------------------
  withDb((db) => {
    sealedIds.forEach((id, index) => {
      db.run(`UPDATE "sealed" SET "_created_at" = ? WHERE "_id" = ?`, [
        `2026-01-01T00:00:0${index}.000Z`,
        id,
      ]);
    });
  });
  openNoteId = insert("open_notes", { body: "みんな読める" });
  oneReaderId = insert("one_reader", { body: "閲覧者だけ読める" });
  conditionalOpenId = insert("conditional", { body: "条件を満たす", kind: "open" });
  conditionalClosedId = insert("conditional", { body: "条件を満たさない", kind: "closed" });
  armedIds = [insert("armed", { title: "付与0件の行" })];
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (A) 規則ゼロの表の行が、運営専用の口に並ぶ
// ---------------------------------------------------------------------------

describe("V8-M41 (A): 規則ゼロで閉じた行が、運営専用の口から取れる", () => {
  test("(A-1) 200 で、並ぶ `_id` が生の SQLite の `_id` と一致する", async () => {
    const response = await raw(DOOR("sealed"), owner.cookie);
    expect(response.status, response.body).toBe(200);
    const body = JSON.parse(response.body) as { records: { _id: string }[]; total: number };
    expect(body.records.map((row) => row._id)).toEqual(rawIds("sealed"));
    expect(body.total).toBe(2);
    expect(rawIds("sealed")).toEqual(sealedIds);
  });

  test("(A-2) 行の中身も返る(運営が中身を見て手当てできる形である)", async () => {
    const response = await raw(DOOR("sealed"), owner.cookie);
    expect(JSON.parse(response.body)).toMatchObject({
      records: [
        { _id: sealedIds[0] as string, body: "誰にも届かない1" },
        { _id: sealedIds[1] as string, body: "誰にも届かない2" },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// (B) 一般の伏せ方を1バイトも動かしていない(`ADR-0317` 限定5 / `ADR-0305` 限定11)
// ---------------------------------------------------------------------------

describe("V8-M41 (B): 一般の一覧・単件の伏せ方は1バイトも動いていない", () => {
  test('(B-1) 同じ表の一覧 `GET` は、運営でも今日どおり `{"records":[],"total":0}` の 200', async () => {
    const response = await raw(RECORDS("sealed"), owner.cookie);
    expect({ status: response.status, body: response.body }).toEqual({
      status: 200,
      body: '{"records":[],"total":0}',
    });
  });

  test("(B-2) 同じ行の単件 `GET` は、運営でも今日どおり 404", async () => {
    const response = await raw(`${RECORDS("sealed")}/${sealedIds[0]}`, owner.cookie);
    expect(response.status).toBe(404);
    // **404 の本文に行の中身が1バイトも載っていない。**
    expect(response.body).not.toContain("誰にも届かない1");
  });

  test("(B-3) `owner` 以外がこの口を叩くと 403(関門を1ミリも緩めていない)", async () => {
    const response = await raw(DOOR("sealed"), viewer.cookie);
    expect(response.status).toBe(403);
    expect(response.body).not.toContain(sealedIds[0] as string);
  });

  test("(B-4) 未認証は 401(認証の壁は判定より手前に立つ)", async () => {
    const response = await raw(DOOR("sealed"));
    expect(response.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// (C) 誰か1人でも読める行は並ばない
// ---------------------------------------------------------------------------

describe("V8-M41 (C): 誰か1人でも読める行は1件も並ばない", () => {
  test("(C-1) 全役割が読める表は 200 の空一覧", async () => {
    expect(await listedIds(DOOR("open_notes"), owner.cookie)).toEqual({ ids: [], total: 0 });
    // **その行は実在する**(空なのは「行が無い」からではない)。
    expect(rawIds("open_notes")).toEqual([openNoteId]);
  });

  test("(C-2) 1つの役割(`viewer`)だけが読める表も、1件も並ばない", async () => {
    expect(await listedIds(DOOR("one_reader"), owner.cookie)).toEqual({ ids: [], total: 0 });
    expect(rawIds("one_reader")).toEqual([oneReaderId]);
    // **運営自身はその表を読めない**(規則を1本も持たない)—— **それでも「取り残し」ではない。**
    const asOwner = await raw(RECORDS("one_reader"), owner.cookie);
    expect(asOwner.body).toBe('{"records":[],"total":0}');
    // **同じ行が `viewer` からは実際に見える**(= 見えている行を取り残しに出していない)。
    expect(await listedIds(RECORDS("one_reader"), viewer.cookie)).toEqual({
      ids: [oneReaderId],
      total: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// (D) 条件つきの規則(**限界をそのまま固定する**)
// ---------------------------------------------------------------------------

describe("V8-M41 (D): 条件つきの規則しか無い表(限界を固定する)", () => {
  test("(D-1) 条件を満たす行は並ばない(実際に読める相手が居る)", async () => {
    const listing = await listedIds(DOOR("conditional"), owner.cookie);
    expect(listing.ids).not.toContain(conditionalOpenId);
  });

  test("(D-2) 条件を満たさない行も並ばない —— **これは限界である**", async () => {
    const listing = await listedIds(DOOR("conditional"), owner.cookie);
    // **【誇張しない】** **`kind: "closed"` の行は今日どの役割からも読めないが、
    // この口には並ばない。** **主体を伏せて判定しているので「誰にも読めない」と
    // 断定できないためである**(`{field, equals_current_user}` の葉が在りうる)。
    expect(listing).toEqual({ ids: [], total: 0 });
    expect(rawIds("conditional")).toEqual([conditionalOpenId, conditionalClosedId]);
  });
});

// ---------------------------------------------------------------------------
// (E) `access_control` を宣言した表は1バイトも変わっていない
// ---------------------------------------------------------------------------

describe("V8-M41 (E): 宣言した表の挙動は着手前と同じである", () => {
  test("(E-1) 付与が0件の行は今日どおり並ぶ(点の側の判定を1バイトも変えていない)", async () => {
    expect(await listedIds(DOOR("armed"), owner.cookie)).toEqual({
      ids: [armedIds[0] as string],
      total: 1,
    });
  });

  test("(E-2) 付与を1件足すと、その行はこの口から消える(点の母集団の定義が動いていない)", async () => {
    const loaded = manifest();
    withDb((db) => {
      const member = createRecord(db, loaded, "armed_member", { account: owner.userId });
      expect(member.ok).toBe(true);
      const granted = createRecord(db, loaded, "armed_grant", {
        armed: armedIds[0] as string,
        member: (member as { value: { _id: string } }).value._id,
        permission: "writer",
      });
      expect(granted.ok).toBe(true);
    });
    expect(await listedIds(DOOR("armed"), owner.cookie)).toEqual({ ids: [], total: 0 });
  });
});

// ---------------------------------------------------------------------------
// (F) 404 が残る条件は2つだけである
// ---------------------------------------------------------------------------

describe("V8-M41 (F): 404 が残るのは実在しない表とシステムが持つ表だけである", () => {
  test("(F-1) 実在しない表は今日も 404", async () => {
    const response = await raw(DOOR("nosuch"), owner.cookie);
    expect(response.status).toBe(404);
  });

  test("(F-2) システムが持つ表は今日も 404(面の判定を1度も受けない表である)", async () => {
    const response = await raw(DOOR("_apps"), owner.cookie);
    expect(response.status).toBe(404);
    expect(response.body).toContain("誰も開けなくなった行の一覧はありません");
  });

  test("(F-3) 404 の案内が、今日の条件を正しく述べている(嘘の案内を残していない)", async () => {
    const response = await raw(DOOR("_apps"), owner.cookie);
    // **旧の `hint`(逐語)**: 「**アクセス権の管理を有効にしたテーブルにだけ、この一覧が
    // あります。**」 —— **今日は偽である**(宣言していない表にもこの一覧が在る)。
    expect(response.body).not.toContain("アクセス権の管理を有効にしたテーブルにだけ");
    expect(response.body).toContain("アプリが自分で作ったテーブルだけです");
  });
});

// ---------------------------------------------------------------------------
// (G) 述語そのもの(**判定の家を増やしていないことの単体**)
// ---------------------------------------------------------------------------

describe("V8-M41 (G): `resolveRecordUnreachableByRoles` の単体", () => {
  test("(G-1) 規則ゼロの表の行は `orphan: true` / `undecided: false`", () => {
    expect(
      resolveRecordUnreachableByRoles({
        manifest: manifest(),
        tableId: "sealed",
        row: { _id: "x", body: "b" },
      }),
    ).toEqual({ kind: "orphan", orphan: true, undecided: false });
  });

  test("(G-2) 誰かが読める表の行は `orphan: false`", () => {
    expect(
      resolveRecordUnreachableByRoles({
        manifest: manifest(),
        tableId: "one_reader",
        row: { _id: "x", body: "b" },
      }),
    ).toEqual({ kind: "orphan", orphan: false, undecided: false });
  });

  test("(G-3) 条件つきで外れた行は `orphan: false` かつ `undecided: true`(断定していない)", () => {
    expect(
      resolveRecordUnreachableByRoles({
        manifest: manifest(),
        tableId: "conditional",
        row: { _id: "x", kind: "closed" },
      }),
    ).toEqual({ kind: "orphan", orphan: false, undecided: true });
  });

  test("(G-4) 役割を1つも宣言していないアプリでも、既定が閉じているので `orphan: true`", () => {
    const bare = {
      app: { id: "bare", name: "無宣言", tables: [{ id: "t", name: "表", fields: [] }] },
    };
    expect(
      resolveRecordUnreachableByRoles({ manifest: bare, tableId: "t", row: { _id: "x" } }),
    ).toEqual({ kind: "orphan", orphan: true, undecided: false });
  });
});
