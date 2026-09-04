/**
 * **`V7-M2-T02` / `Z-G11`**: **権限名ごとの「読む / 書く / 消す」が、サーバの判定に効く。**
 *
 * **判定の家は `judgeRecordAccess`(`src/server/owner-scope.ts`)1本である**
 * (`v7-m0.md` §5-2 (b) / `Z-G11` 限定3)。**`judgeOwnerScopedOp` の中には入れていない** ——
 * **入れるとワークフロー(`src/kernel/workflow-runner.ts`)と受信口(`src/server/inbound-route.ts`)が
 * 判定を受けてしまい、`Z-G22` / `Z-G23`(今日どおり素通りする)と正面から食い違う**(同 §5-2 (b) の逐語)。
 *
 * ## **本ファイルが測る範囲 —— 3経路だけである(誇張しない)**
 *
 * **配線したのは 一覧 `GET` / 単件 `GET` / `PATCH` の3経路だけである。**
 * **`POST` / `DELETE` / 画面の操作起点 / バッチ / ファイル配信の5経路には、判定が1バイトも
 * 掛かっていない**(担当は `V7-M3-T02` / `V7-M3-T06` / `V7-M3-T07`)。
 * **本ファイルは、その5経路のうち `POST` と `DELETE` について「今日は素通りする」ことを
 * 実際に測って固定する**(§(D))—— **「守られるようになった」と書かないための実測である。**
 *
 * ## **本タスクが実装していないもの(検査でも固定する)**
 *
 *  1. **グループ経由の解決**(`grant.group` → グループ表 → `members.group`)—— **`V7-M3-T01`。**
 *     **本ファイルの (C) が「グループだけの付与は今日1ミリも効かない」ことを測っている。**
 *  2. **引き継ぎ(`inherit_from` の多段)** —— **`V7-M4`。**
 *  3. **メンバー表に行が無い人の作成拒否(400)** —— **`V7-M3-T02`**(`v7-m0.md` §5-5 (a))。
 *  4. **`delete` ブールは返るが、`DELETE` 経路に配線していない** —— **`V7-M3-T06`。**
 *
 * ## 追記(`V7-M3-T01` / `Z-G1`。2026-08-08)—— **上の文を1バイトも消していない**
 *
 * **上の「本タスクが実装していないもの」の1(グループ経由の解決)は、`V7-M3-T01` が実装した。**
 * **したがって (C) の期待値は `false` から `true` に変わっている**(旧文は同節にコメントで
 * 逐語で残してある)。**足したのは (F)(述語)と (G)(HTTP。5人 × 3経路)である。**
 *
 * **【`V7-M3-T01` が実装していないもの。先に書く(憲法6)】**
 *  - **引き継ぎ(`inherit_from` の多段)は今日も1バイトも実装していない** —— **`V7-M4`。**
 *  - **`POST` / `DELETE` / 画面の操作起点 / バッチ / ファイル配信の5経路は今日も素通りする** ——
 *    **`V7-M3-T02` / `V7-M3-T06` / `V7-M3-T07`。**(D) がそのうち2本を今日も実測している。
 *  - **グループ表の行を1行も読まない** —— **消えたグループ行を指す付与の扱いは `V7-M3-T05`。**
 *
 * ## 追記(`V7-M3-T02`。2026-08-08)—— **上の文を1バイトも消していない**
 *
 * **上の「本タスクが実装していないもの」の3(メンバー表に行が無い人の作成拒否)は
 * `V7-M3-T02` が実装した。** **あわせて `POST` / 画面の操作起点 / バッチの3経路に判定を
 * 配線した。** **したがって (D) の `POST` の検査は「素通りする」ではなく「見たうえで
 * 通っている」を測るものに変わっている**(旧文は同節にコメントで逐語で残してある)。
 *
 * **【`V7-M3-T02` の後も残るもの】**
 *  - **`DELETE` は今日も `delete` を持たない人が通る**(`V7-M3-T06`)—— (D) がそれを今日も
 *    実測している。**ファイル配信も今日どおりである**(`V7-M3-T07`)。
 *  - **8経路の状態を1本ずつ数える検査は `src/server/access-control-paths.test.ts` に在る。**
 *
 * ## 追記(`V7-M3-T06`。2026-08-08)—— **上の文を1バイトも消していない**
 *
 * **上の「本タスクが実装していないもの」の4(`delete` ブールは返るが `DELETE` 経路に
 * 配線していない)は、`V7-M3-T06` が実装した。** **したがって (D) の最後の describe
 * 「配線していない経路は今日どおり素通りする」は、今日は `DELETE` について成り立たない**
 * (旧の名前と旧の期待値は、その2本のテストの直前にコメントで逐語で残してある)。
 *
 * **`DELETE` の関門の順序は `v7-m0.md` §5-4 の (vi)**: **(1) 所有者スコープ 404 →
 * (2) 付与の可視性 404 →(3) 付与の「消す」403 →(4) 削除保護 409。**
 * **4段の実測は `src/server/access-control-delete.test.ts` に在る。**
 *
 * **【`V7-M3-T06` の後も残るもの】**
 *  - **ファイル配信は今日も判定を1バイトも受けない**(`V7-M3-T07`)。
 *  - **`DELETE` 経路は今日もトランザクションを1つも開かない** —— **TOCTOU の窓は残る。**
 *  - **MCP / 受信口 / ワークフロー / コードの島は今日も同じ行を消せる**(`Z-G21`〜`Z-G24`)。
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
  type Table,
} from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { judgeRecordAccess, recordAccessSourceTables } from "./owner-scope.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

/**
 * 移した公開単位の根(`apps/smailtalk/`)。**`import.meta.dir` から数える** ——
 * cwd 相対で解くと `bun test` を打つ場所で結果が変わる(`src/` はもうルート直下に無い)。
 */
const PRODUCT_ROOT = join(import.meta.dir, "..", "..");

const APP_ID = "book-shelf";

/** 権限名3つ。**`read` / `write` / `delete` の3つちょうどで、4つ目の動詞は無い**(限定1)。 */
const PERMISSIONS = [
  { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
  { id: "writer", name: "編集できる", read: true, write: true, delete: false },
  { id: "keeper", name: "消せる", read: true, write: true, delete: true },
] as const;

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "蔵書",
      tables: [
        {
          id: "books",
          name: "書籍",
          fields: [
            { id: "title", name: "タイトル", type: "text", required: true },
            { id: "note", name: "メモ", type: "long_text" },
          ],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "keeper",
            grant: {
              table: "book_grant",
              target: "book",
              member: "member",
              group: "team",
              permission: "permission",
            },
            members: { table: "book_member", account: "account", group: "team" },
            groups: { table: "book_team" },
          },
        },
        {
          // **宣言していない表**(オプトインの対照。ここは今日と1バイトも変わらない)。
          id: "notes",
          name: "メモ",
          fields: [{ id: "body", name: "本文", type: "text" }],
        },
        {
          id: "book_team",
          name: "グループ",
          fields: [{ id: "title", name: "名前", type: "text" }],
        },
        {
          id: "book_member",
          name: "利用者",
          fields: [
            { id: "account", name: "ログイン", type: "text" },
            { id: "team", name: "グループ", type: "reference", reference_table: "book_team" },
          ],
        },
        {
          id: "book_grant",
          name: "本の付与",
          fields: [
            { id: "book", name: "本", type: "reference", reference_table: "books" },
            { id: "member", name: "相手", type: "reference", reference_table: "book_member" },
            { id: "team", name: "グループ", type: "reference", reference_table: "book_team" },
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
    },
  } as unknown as Manifest;
}

/**
 * **【`V8-M26`】面(役割に束ねた権限)の規則を足した題材**(適用に渡すのはこちら)。
 *
 * **`V8-M26` が面の既定を「閉じる」側へ倒した** —— **規則を1本も名指ししていない
 * `table` / `view` / `action` は拒否される**(ユーザ決定 `D-V8-45` / `D-V8-65`)。
 * **実アプリでは差分の畳み込み(`src/kernel/apply-diff.ts`)が既定3役割へ規則を自動で
 * 足すが、本検査は `applyManifest` を直接呼ぶのでその経路を1度も通らない。**
 * **そのぶんだけを `withDefaultRoleRules` で埋める**(判定の実装は1バイトも触っていない)。
 *
 * **`books` は `skipTables` で外す** —— **`access_control` を宣言した表であり、面の規則を
 * 1本でも足すと面と点が `OR` で重なって全員が通り、本ファイルの主題(**行ごとの付与だけで
 * 3動詞の可否が決まること**)が丸ごと測れなくなる。**
 *
 * **述語(`judgeRecordAccess`)を直に呼ぶ (A) 群は、今日も `manifest()` の側を使う** ——
 * **述語は面を1バイトも見ないので、規則を足しても足さなくても答えは同じである。**
 */
function manifestWithRoles(): Manifest {
  return withDefaultRoleRules(manifest(), { skipTables: ["books"] });
}

function tableOf(source: Manifest, tableId: string): Table {
  const table = source.app.tables.find((candidate) => candidate.id === tableId);
  if (table === undefined) {
    throw new Error(`表 "${tableId}" がフィクスチャに無い`);
  }
  return table;
}

// ---------------------------------------------------------------------------
// (A) 述語そのもの —— 入力は (マニフェスト, 表ID, 行, actor, 付与行・利用者行) に閉じる
// ---------------------------------------------------------------------------

describe("V7-M2-T02 (A): judgeRecordAccess は付与行の権限名を引いて3ブールを返す", () => {
  const base = manifest();
  const row = { _id: "row-1", title: "吾輩は猫である" };
  const memberRows = [
    { _id: "m-b", account: "user-b" },
    { _id: "m-c", account: "user-c" },
  ];

  test("宣言していない表は3つとも true(今日どおり = この判定は何も絞らない)", () => {
    expect(
      judgeRecordAccess({
        manifest: base,
        tableId: "notes",
        row,
        actorId: "user-b",
        grantRows: [],
        memberRows: [],
      }),
    ).toEqual({ read: true, write: true, delete: true });
  });

  test("宣言した表で付与が1件も無ければ3つとも false(fail-closed)", () => {
    expect(
      judgeRecordAccess({
        manifest: base,
        tableId: "books",
        row,
        actorId: "user-b",
        grantRows: [],
        memberRows,
      }),
    ).toEqual({ read: false, write: false, delete: false });
  });

  test("read だけの権限名の付与は read だけが true になる", () => {
    expect(
      judgeRecordAccess({
        manifest: base,
        tableId: "books",
        row,
        actorId: "user-b",
        grantRows: [{ _id: "g-1", book: "row-1", member: "m-b", permission: "reader" }],
        memberRows,
      }),
    ).toEqual({ read: true, write: false, delete: false });
  });

  test("write を持つ権限名の付与は read と write が true になる", () => {
    expect(
      judgeRecordAccess({
        manifest: base,
        tableId: "books",
        row,
        actorId: "user-c",
        grantRows: [{ _id: "g-2", book: "row-1", member: "m-c", permission: "writer" }],
        memberRows,
      }),
    ).toEqual({ read: true, write: true, delete: false });
  });

  test("delete を持つ権限名の付与は delete も true になる(**返るだけで DELETE には配線していない**)", () => {
    expect(
      judgeRecordAccess({
        manifest: base,
        tableId: "books",
        row,
        actorId: "user-c",
        grantRows: [{ _id: "g-3", book: "row-1", member: "m-c", permission: "keeper" }],
        memberRows,
      }),
    ).toEqual({ read: true, write: true, delete: true });
  });

  test("同じ相手への複数の付与は or で重なる", () => {
    expect(
      judgeRecordAccess({
        manifest: base,
        tableId: "books",
        row,
        actorId: "user-b",
        grantRows: [
          { _id: "g-1", book: "row-1", member: "m-b", permission: "reader" },
          { _id: "g-4", book: "row-1", member: "m-b", permission: "writer" },
        ],
        memberRows,
      }),
    ).toEqual({ read: true, write: true, delete: false });
  });

  test("別の行への付与は、この行に1ミリも効かない(付与はその表のその行にしか効かない)", () => {
    expect(
      judgeRecordAccess({
        manifest: base,
        tableId: "books",
        row,
        actorId: "user-b",
        grantRows: [{ _id: "g-5", book: "row-2", member: "m-b", permission: "keeper" }],
        memberRows,
      }),
    ).toEqual({ read: false, write: false, delete: false });
  });

  test("別の人への付与は、この actor に効かない", () => {
    expect(
      judgeRecordAccess({
        manifest: base,
        tableId: "books",
        row,
        actorId: "user-b",
        grantRows: [{ _id: "g-6", book: "row-1", member: "m-c", permission: "keeper" }],
        memberRows,
      }),
    ).toEqual({ read: false, write: false, delete: false });
  });

  test("actor を特定できない実行(匿名)は3つとも false", () => {
    expect(
      judgeRecordAccess({
        manifest: base,
        tableId: "books",
        row,
        actorId: null,
        grantRows: [{ _id: "g-1", book: "row-1", member: "m-b", permission: "reader" }],
        memberRows,
      }),
    ).toEqual({ read: false, write: false, delete: false });
  });

  test("宣言に無い権限名を書いた付与行は1ミリも効かない(付与行の値は宣言で解決する)", () => {
    expect(
      judgeRecordAccess({
        manifest: base,
        tableId: "books",
        row,
        actorId: "user-b",
        grantRows: [{ _id: "g-7", book: "row-1", member: "m-b", permission: "manager" }],
        memberRows,
      }),
    ).toEqual({ read: false, write: false, delete: false });
  });

  test("メンバー表に行が無い人は、付与を解決できない", () => {
    expect(
      judgeRecordAccess({
        manifest: base,
        tableId: "books",
        row,
        actorId: "user-z",
        grantRows: [{ _id: "g-1", book: "row-1", member: "m-b", permission: "reader" }],
        memberRows,
      }),
    ).toEqual({ read: false, write: false, delete: false });
  });

  test("入力を1バイトも書き換えない", () => {
    const grantRows = [{ _id: "g-1", book: "row-1", member: "m-b", permission: "reader" }];
    const before = JSON.stringify({ base, row, grantRows, memberRows });
    judgeRecordAccess({
      manifest: base,
      tableId: "books",
      row,
      actorId: "user-b",
      grantRows,
      memberRows,
    });
    expect(JSON.stringify({ base, row, grantRows, memberRows })).toBe(before);
  });

  test("壊れた形でも例外を投げない(述語が投げると読取経路が 500 になる)", () => {
    expect(() =>
      judgeRecordAccess({
        manifest: { app: { id: "x", name: "x", tables: null } } as unknown as Manifest,
        tableId: "books",
        row: {} as Record<string, unknown>,
        actorId: "user-b",
        grantRows: [null as unknown as Record<string, unknown>],
        memberRows: [undefined as unknown as Record<string, unknown>],
      }),
    ).not.toThrow();
  });

  test("enabled: false の表は「宣言していない表」と同じ扱いである", () => {
    const disabled = manifest();
    const books = tableOf(disabled, "books") as unknown as Record<string, unknown>;
    (books.access_control as Record<string, unknown>).enabled = false;
    expect(
      judgeRecordAccess({
        manifest: disabled,
        tableId: "books",
        row,
        actorId: "user-b",
        grantRows: [],
        memberRows,
      }),
    ).toEqual({ read: true, write: true, delete: true });
  });
});

describe("V7-M2-T02 (B): recordAccessSourceTables —— 読む表を宣言から引く", () => {
  test("宣言した表は付与表とメンバー表とグループ表を返す", () => {
    // **【`V7-M3-T05` が期待値を更新した。旧文を逐語で残す。1本も削除していない】**
    //   旧題名: `test("宣言した表は付与表とメンバー表を返す", …)`
    //   旧期待値: `expect(recordAccessSourceTables(manifest(), "books")).toEqual({`
    //             `  grantTable: "book_grant",`
    //             `  memberTable: "book_member",`
    //             `});`
    // **`V7-M3-T05`(`Z-G32`)が「消えたグループ行を指す付与は効かない」を実装するために、
    // グループ表の行の実在を見るようになった** —— **読む表が1本増えた**(`v7-m3.md` §2-5)。
    expect(recordAccessSourceTables(manifest(), "books")).toEqual({
      grantTable: "book_grant",
      memberTable: "book_member",
      groupTable: "book_team",
    });
  });

  test("宣言していない表は undefined(= この経路に1バイトも掛からない)", () => {
    expect(recordAccessSourceTables(manifest(), "notes")).toBeUndefined();
  });

  test("実在しない表IDでも例外を投げず undefined を返す", () => {
    expect(recordAccessSourceTables(manifest(), "nope")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (C) 本タスクが実装していないもの —— 実測して固定する
// ---------------------------------------------------------------------------

describe("V7-M2-T02 (C): 引き継ぎは実装していない(V7-M4)。グループ経由は V7-M3-T01 が実装した", () => {
  // **【旧文を1バイトも消していない。逐語でここに残す】**
  //
  //   test("グループだけを指した付与は、今日1ミリも効かない(V7-M3-T01 の担当)", () => {
  //     // **メンバー行 `m-b` はグループ `t-1` に属し、付与はそのグループを指している。**
  //     // **それでも `read` は立たない** —— **本タスクは直接の付与しか解決しないためである。**
  //     expect(…).toEqual({ read: false, write: false, delete: false });
  //   });
  //
  // **`V7-M2-T02` の当時はこれが正だった。** **`V7-M3-T01`(`Z-G1`)がグループ経由の解決を
  // 実装したので、まったく同じ入力に対する今日の正は下の3つ true である。**
  // **検査は1本も削除していない —— 期待値を今日の正に更新した。**
  test("グループだけを指した付与が効く(V7-M3-T01 が false → true に変えた)", () => {
    // **メンバー行 `m-b` はグループ `t-1` に属し、付与はそのグループを指している。**
    expect(
      judgeRecordAccess({
        manifest: manifest(),
        tableId: "books",
        row: { _id: "row-1" },
        actorId: "user-b",
        grantRows: [{ _id: "g-8", book: "row-1", team: "t-1", permission: "keeper" }],
        memberRows: [{ _id: "m-b", account: "user-b", team: "t-1" }],
      }),
    ).toEqual({ read: true, write: true, delete: true });
  });

  test("judgeRecordAccess は引き継ぎ(inherit_from)を1度も辿らない(V7-M4 の担当)", () => {
    const inherited = manifest();
    const books = tableOf(inherited, "books") as unknown as Record<string, unknown>;
    (books.access_control as Record<string, unknown>).inherit_from = ["parent"];
    (books.fields as Record<string, unknown>[]).push({
      id: "parent",
      name: "親",
      type: "reference",
      reference_table: "books",
    });
    // 親(row-0)には付与が在るが、子(row-1)には無い。**辿らないので false のままである。**
    expect(
      judgeRecordAccess({
        manifest: inherited,
        tableId: "books",
        row: { _id: "row-1", parent: "row-0" },
        actorId: "user-b",
        grantRows: [{ _id: "g-9", book: "row-0", member: "m-b", permission: "keeper" }],
        memberRows: [{ _id: "m-b", account: "user-b" }],
      }),
    ).toEqual({ read: false, write: false, delete: false });
  });
});

// ---------------------------------------------------------------------------
// (D) HTTP —— 3人の actor で同じ行を叩く
// ---------------------------------------------------------------------------

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;
/** 付与なし / `reader` の付与 / `writer` の付与 の3人。 */
let none: ReturnType<typeof seedSession>;
let reader: ReturnType<typeof seedSession>;
let writer: ReturnType<typeof seedSession>;
/** 付与のある行 / 付与の無い行 / 削除の実測に使う行。 */
let granted = "";
let ungranted = "";
let deletable = "";
let noteId = "";

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

async function patch(
  path: string,
  cookie: string,
  ifMatch: string,
  values: Record<string, unknown>,
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

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-acv-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "蔵書", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, manifestWithRoles()).valid).toBe(true);
  app = createServerApp({ dataRoot });

  // **3人とも `editor`** —— **ロールの差で結果が動かないようにする。**
  // **差は「どの付与を持っているか」だけである。**
  none = seedSession(dataRoot, APP_ID, { role: "editor", username: "none" });
  reader = seedSession(dataRoot, APP_ID, { role: "editor", username: "reader" });
  writer = seedSession(dataRoot, APP_ID, { role: "editor", username: "writer" });

  const loaded = manifest();
  withDb((db) => {
    const book = (title: string): string => {
      const created = createRecord(db, loaded, "books", { title });
      expect(created.ok).toBe(true);
      return (created as { value: { _id: string } }).value._id;
    };
    granted = book("付与のある本");
    ungranted = book("付与の無い本");
    deletable = book("消される本");
    const note = createRecord(db, loaded, "notes", { body: "宣言していない表" });
    expect(note.ok).toBe(true);
    noteId = (note as { value: { _id: string } }).value._id;

    // **3人ともメンバー表に行を持つ** —— **「付与が無い」と「メンバー行が無い」を分けるため。**
    const member = (account: string): string => {
      const created = createRecord(db, loaded, "book_member", { account });
      expect(created.ok).toBe(true);
      return (created as { value: { _id: string } }).value._id;
    };
    member(none.userId);
    const readerMember = member(reader.userId);
    const writerMember = member(writer.userId);

    const grant = (bookId: string, memberId: string, permission: string): void => {
      const created = createRecord(db, loaded, "book_grant", {
        book: bookId,
        member: memberId,
        permission,
      });
      expect(created.ok).toBe(true);
    };
    grant(granted, readerMember, "reader");
    grant(granted, writerMember, "writer");
    grant(deletable, readerMember, "reader");
  });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

describe("V7-M2-T02 (D): 一覧 GET —— 付与のある行だけが返る", () => {
  test("付与の無い人には1件も返らない", async () => {
    const response = await get(`/api/apps/${APP_ID}/tables/books/records`, none.cookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { records: { _id: string }[]; total: number };
    expect(body.records).toEqual([]);
    expect(body.total).toBe(0);
  });

  test("read だけを持つ人には、付与のある行だけが返る(付与の無い行は1件も返らない)", async () => {
    const response = await get(`/api/apps/${APP_ID}/tables/books/records`, reader.cookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { records: { _id: string }[]; total: number };
    expect(body.records.map((record) => record._id).sort()).toEqual([granted, deletable].sort());
    expect(body.total).toBe(2);
    expect(body.records.some((record) => record._id === ungranted)).toBe(false);
  });

  test("write を持つ人にも、付与のある行だけが返る", async () => {
    const response = await get(`/api/apps/${APP_ID}/tables/books/records`, writer.cookie);
    const body = (await response.json()) as { records: { _id: string }[]; total: number };
    expect(body.records.map((record) => record._id)).toEqual([granted]);
    expect(body.total).toBe(1);
  });

  test("宣言していない表は今日どおり全件返る(オプトイン)", async () => {
    for (const session of [none, reader, writer]) {
      const response = await get(`/api/apps/${APP_ID}/tables/notes/records`, session.cookie);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { records: { _id: string }[]; total: number };
      expect(body.records.map((record) => record._id)).toEqual([noteId]);
    }
  });
});

describe("V7-M2-T02 (D): 単件 GET —— 見えない行は存在を伏せて 404", () => {
  test("付与の無い人は 404(403 ではない。存在を伏せる)", async () => {
    const response = await get(`/api/apps/${APP_ID}/tables/books/records/${granted}`, none.cookie);
    expect(response.status).toBe(404);
  });

  test("read だけを持つ人は 200 で読める", async () => {
    const response = await get(
      `/api/apps/${APP_ID}/tables/books/records/${granted}`,
      reader.cookie,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { record: { _id: string } };
    expect(body.record._id).toBe(granted);
  });

  test("付与のある人でも、付与の無い行は 404", async () => {
    const response = await get(
      `/api/apps/${APP_ID}/tables/books/records/${ungranted}`,
      reader.cookie,
    );
    expect(response.status).toBe(404);
  });
});

describe("V7-M2-T02 (D): PATCH —— read だけなら 403、write を持てば通る", () => {
  async function etag(session: ReturnType<typeof seedSession>, recordId: string): Promise<string> {
    const response = await get(
      `/api/apps/${APP_ID}/tables/books/records/${recordId}`,
      session.cookie,
    );
    expect(response.status).toBe(200);
    const value = response.headers.get("etag");
    expect(value).not.toBeNull();
    return value as string;
  }

  test("(完了条件 i) read だけを持つ人の PATCH は 403", async () => {
    const version = await etag(reader, granted);
    const response = await patch(
      `/api/apps/${APP_ID}/tables/books/records/${granted}`,
      reader.cookie,
      version,
      { title: "書き換えたい" },
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { errors: { message: string }[] };
    // **利用者の言葉である**(内部記号を1文字も出さない)。
    const message = body.errors[0]?.message ?? "";
    expect(message).not.toContain("access_control");
    expect(message).not.toContain("Z-G");
    expect(message.length).toBeGreaterThan(0);
  });

  test("(完了条件 ii) write を持つ人の PATCH は 200 で通る(拒否側だけを示さない)", async () => {
    const version = await etag(writer, granted);
    const response = await patch(
      `/api/apps/${APP_ID}/tables/books/records/${granted}`,
      writer.cookie,
      version,
      { title: "書き換えた" },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { record: { title: string } };
    expect(body.record.title).toBe("書き換えた");
  });

  test("付与の無い人の PATCH は 404(403 ではない。存在を伏せる側が先)", async () => {
    const version = await etag(writer, granted);
    const response = await patch(
      `/api/apps/${APP_ID}/tables/books/records/${granted}`,
      none.cookie,
      version,
      { title: "書き換えたい" },
    );
    expect(response.status).toBe(404);
  });

  test("宣言していない表の PATCH は今日どおり通る", async () => {
    const single = await get(`/api/apps/${APP_ID}/tables/notes/records/${noteId}`, none.cookie);
    const version = single.headers.get("etag") as string;
    const response = await patch(
      `/api/apps/${APP_ID}/tables/notes/records/${noteId}`,
      none.cookie,
      version,
      { body: "書き換えた" },
    );
    expect(response.status).toBe(200);
  });
});

describe("V7-M2-T02 (D): 配線していない経路は今日どおり素通りする(実測して固定する)", () => {
  /*
   * **【`V7-M3-T02` による更新。旧文を1バイトも消していない】**
   *
   * **旧: `test("POST は 400 にならない —— メンバー行の有無も付与も1ミリも見ていない(V7-M3-T02)", …)`**
   * **旧の本体は `expect(response.status).toBe(201);` の1行だけであった。**
   *
   * **今日は `POST` に判定が配線されている**(`V7-M3-T02`)。**それでもこの `none` は
   * メンバー表に行を持っているので、応答は今日も `201` である** —— **変わったのは
   * 「見ていない」ことではなく「見たうえで通っている」ことである。**
   * **作成者への自動付与が1件入るようになったので、その1件も測り足した。**
   * **メンバー表に行が無い人が 400 で止まることは
   * `src/server/access-control-paths.test.ts` の (D-1) が測っている。**
   */
  test("POST は 201 のまま —— ただし今日はメンバー行を見たうえで通っており、作成者への付与が1件入る(V7-M3-T02)", async () => {
    const response = await app.request(`/api/apps/${APP_ID}/tables/books/records`, {
      method: "POST",
      headers: {
        cookie: none.cookie,
        origin: TEST_ORIGIN,
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "誰でも作れる" }),
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { record: { _id: string } };
    const grants = withDb(
      (db) =>
        db.query("SELECT permission FROM book_grant WHERE book = ?").all(created.record._id) as {
          permission: string;
        }[],
    );
    // **`creator_permission` は `keeper` である**(このフィクスチャの宣言)。
    expect(grants).toEqual([{ permission: "keeper" }]);
  });

  /*
   * **【`V7-M3-T06` による更新。旧文を1バイトも消していない】**
   *
   * **旧: `test("DELETE は `delete` を持たない権限名の人でも通る(V7-M3-T06 が配線する)", …)`**
   * **旧の本体の逐語**: 「**`reader` の `delete` は false である。それでも 204 で消える。**」
   * **旧の期待値は `expect(response.status).toBe(204);` であった。**
   *
   * **`V7-M3-T06` が `DELETE` に行ごとのアクセス権の `delete` を配線した。**
   * **したがって `reader` の `DELETE` は 403 で止まる** —— **行は見えているので 404 では
   * ない**(関門の順序は `v7-m0.md` §5-4 の (vi))。
   */
  test("DELETE は `delete` を持たない権限名の人には 403(V7-M3-T06 が配線した)", async () => {
    const single = await get(
      `/api/apps/${APP_ID}/tables/books/records/${deletable}`,
      reader.cookie,
    );
    expect(single.status).toBe(200);
    const version = single.headers.get("etag") as string;
    const response = await app.request(`/api/apps/${APP_ID}/tables/books/records/${deletable}`, {
      method: "DELETE",
      headers: { cookie: reader.cookie, origin: TEST_ORIGIN, "if-match": version },
    });
    expect(response.status).toBe(403);
  });

  /*
   * **【`V7-M3-T06` による更新。旧文を1バイトも消していない】**
   *
   * **旧: `test("付与の無い行も DELETE できる —— 読取だけを配線したことの裏(V7-M3-T06)", …)`**
   * **旧の期待値は `expect(response.status).toBe(204);` であった。**
   *
   * **今日は 404 である** —— **見えない行に 403 を返すと、その行が在ることが漏れる。**
   */
  test("付与の無い行の DELETE は 404(存在を伏せる側が先。V7-M3-T06)", async () => {
    const version = withDb((db) => {
      const row = db.query("SELECT _updated_at FROM books WHERE _id = ?").get(ungranted) as {
        _updated_at: string;
      } | null;
      return (row as { _updated_at: string })._updated_at;
    });
    const response = await app.request(`/api/apps/${APP_ID}/tables/books/records/${ungranted}`, {
      method: "DELETE",
      headers: { cookie: none.cookie, origin: TEST_ORIGIN, "if-match": version },
    });
    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// (E) 判定式の置き場所(`ADR-0061` 限定4 / 完了条件 iii)
// ---------------------------------------------------------------------------

describe("V7-M2-T02 (E): 判定式は app.ts に1行も無い", () => {
  test("(完了条件 iii) src/server/app.ts に access_control の綴りが1件も無い", async () => {
    const source = await Bun.file(join(PRODUCT_ROOT, "src", "server", "app.ts")).text();
    expect(source.includes("access_control")).toBe(false);
  });

  test("(V7-M3-T01 完了条件 iii) judgeRecordAccess は MCP / 受信口 / カーネルから1度も呼ばれない(Z-G21〜Z-G24 の素通り)", async () => {
    const roots = [
      join(PRODUCT_ROOT, "src", "mcp"),
      join(PRODUCT_ROOT, "src", "kernel"),
      join(PRODUCT_ROOT, "src", "server", "inbound-route.ts"),
    ];
    const hits: string[] = [];
    for (const root of roots) {
      const stat = await Bun.file(root).exists();
      if (stat) {
        if ((await Bun.file(root).text()).includes("judgeRecordAccess")) {
          hits.push(root);
        }
        continue;
      }
      const entries = await Array.fromAsync(
        new Bun.Glob("**/*.ts").scan({ cwd: root, absolute: false }),
      );
      for (const entry of entries) {
        const path = join(root, entry);
        if ((await Bun.file(path).text()).includes("judgeRecordAccess")) {
          hits.push(path);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (F) `V7-M3-T01` / `Z-G1`: グループ経由の解決(**固定3段**)
//
// **辿る道は1本だけである**:
//   **付与行 → `grant.group` → グループ → メンバー表の `members.group` が同じグループを
//   指す行 → `members.account` → actor**
// **グループの中にグループは入らない**(`Z-G8` の裁定。適用時検査
// `src/kernel/referential-integrity.ts` が「グループの表がグループの表自身を参照している」
// 宣言を拒否するので、入れ子は宣言できない)。
//
// **【本節が測っていないもの。先に書く(憲法6)】**
//  1. **引き継ぎ(`inherit_from` の多段)は今日も1バイトも実装していない** —— **`V7-M4`。**
//  2. **`POST` / `DELETE` / 画面の操作起点 / バッチ / ファイル配信の5経路は今日も素通りする**
//     —— **`V7-M3-T02` / `V7-M3-T06` / `V7-M3-T07`。**
//  3. **消えたグループ行を指す付与の扱いは `V7-M3-T05` の担当である** ——
//     **本節はグループ表の行を1行も読まない**(下の「グループ表の行を読まない」の検査が
//     その事実を固定している)。
// ---------------------------------------------------------------------------

describe("V7-M3-T01 (F): グループ経由の解決(固定3段)", () => {
  const base = manifest();
  const row = { _id: "row-1", title: "吾輩は猫である" };
  /** `m-b` はグループ `t-1`、`m-c` はグループ `t-2`、`m-d` はどのグループにも属さない。 */
  const memberRows = [
    { _id: "m-b", account: "user-b", team: "t-1" },
    { _id: "m-c", account: "user-c", team: "t-2" },
    { _id: "m-d", account: "user-d" },
  ];

  test("グループへの付与が、そのグループに属する人に効く", () => {
    expect(
      judgeRecordAccess({
        manifest: base,
        tableId: "books",
        row,
        actorId: "user-b",
        grantRows: [{ _id: "g-1", book: "row-1", team: "t-1", permission: "reader" }],
        memberRows,
      }),
    ).toEqual({ read: true, write: false, delete: false });
  });

  test("同じグループへの1件の付与が、そのグループの全員に効く(1行が複数の人から見える)", () => {
    const grantRows = [{ _id: "g-1", book: "row-1", team: "t-1", permission: "reader" }];
    const second = [...memberRows, { _id: "m-b2", account: "user-b2", team: "t-1" }];
    for (const actorId of ["user-b", "user-b2"]) {
      expect(
        judgeRecordAccess({
          manifest: base,
          tableId: "books",
          row,
          actorId,
          grantRows,
          memberRows: second,
        }),
      ).toEqual({ read: true, write: false, delete: false });
    }
  });

  test("別のグループへの付与は効かない", () => {
    expect(
      judgeRecordAccess({
        manifest: base,
        tableId: "books",
        row,
        actorId: "user-c",
        grantRows: [{ _id: "g-1", book: "row-1", team: "t-1", permission: "keeper" }],
        memberRows,
      }),
    ).toEqual({ read: false, write: false, delete: false });
  });

  test("どのグループにも属さない人には、グループへの付与が1ミリも効かない", () => {
    expect(
      judgeRecordAccess({
        manifest: base,
        tableId: "books",
        row,
        actorId: "user-d",
        grantRows: [{ _id: "g-1", book: "row-1", team: "t-1", permission: "keeper" }],
        memberRows,
      }),
    ).toEqual({ read: false, write: false, delete: false });
  });

  test("別の行へのグループ付与は、この行に1ミリも効かない", () => {
    expect(
      judgeRecordAccess({
        manifest: base,
        tableId: "books",
        row,
        actorId: "user-b",
        grantRows: [{ _id: "g-1", book: "row-2", team: "t-1", permission: "keeper" }],
        memberRows,
      }),
    ).toEqual({ read: false, write: false, delete: false });
  });

  test("2つのグループへの付与が、それぞれのグループの人に別々に効く(1行が複数のグループから見える)", () => {
    const grantRows = [
      { _id: "g-1", book: "row-1", team: "t-1", permission: "reader" },
      { _id: "g-2", book: "row-1", team: "t-2", permission: "writer" },
    ];
    expect(
      judgeRecordAccess({
        manifest: base,
        tableId: "books",
        row,
        actorId: "user-b",
        grantRows,
        memberRows,
      }),
    ).toEqual({ read: true, write: false, delete: false });
    expect(
      judgeRecordAccess({
        manifest: base,
        tableId: "books",
        row,
        actorId: "user-c",
        grantRows,
        memberRows,
      }),
    ).toEqual({ read: true, write: true, delete: false });
  });

  // **【OR で合成する裁定は `V7-M3-T01` が下した】** —— **同じ行に複数の付与が付いていたら、
  // `read` / `write` / `delete` のそれぞれについて、1件でも真を与える付与があれば真にする。**
  // **理由**: **弱い方に倒すと「グループに入れたら権限が**減った**」という、利用者に説明
  // できない挙動になるためである**(直接の付与と、グループ経由の付与が同じ行に付いたとき)。
  test("(OR の合成) グループ経由の read のみ + 直接の write → read も write も真になる", () => {
    expect(
      judgeRecordAccess({
        manifest: base,
        tableId: "books",
        row,
        actorId: "user-b",
        grantRows: [
          { _id: "g-1", book: "row-1", team: "t-1", permission: "reader" },
          { _id: "g-2", book: "row-1", member: "m-b", permission: "writer" },
        ],
        memberRows,
      }),
    ).toEqual({ read: true, write: true, delete: false });
  });

  test("(OR の合成) 弱い付与を後から足しても、既にある強い付与は1ミリも下がらない", () => {
    expect(
      judgeRecordAccess({
        manifest: base,
        tableId: "books",
        row,
        actorId: "user-b",
        grantRows: [
          { _id: "g-1", book: "row-1", member: "m-b", permission: "keeper" },
          { _id: "g-2", book: "row-1", team: "t-1", permission: "reader" },
        ],
        memberRows,
      }),
    ).toEqual({ read: true, write: true, delete: true });
  });

  test("1件の付与行に相手とグループの両方が書いてあれば、どちらか一致で効く(OR)", () => {
    const grantRows = [
      { _id: "g-1", book: "row-1", member: "m-d", team: "t-1", permission: "writer" },
    ];
    for (const actorId of ["user-b", "user-d"]) {
      expect(
        judgeRecordAccess({
          manifest: base,
          tableId: "books",
          row,
          actorId,
          grantRows,
          memberRows,
        }),
      ).toEqual({ read: true, write: true, delete: false });
    }
  });

  test("グループを1度も辿らない宣言(members.group が無い)では、グループ付与は効かない", () => {
    const noGroup = manifest();
    const declaration = (tableOf(noGroup, "books") as unknown as Record<string, unknown>)
      .access_control as Record<string, unknown>;
    declaration.members = { table: "book_member", account: "account" };
    expect(
      judgeRecordAccess({
        manifest: noGroup,
        tableId: "books",
        row,
        actorId: "user-b",
        grantRows: [{ _id: "g-1", book: "row-1", team: "t-1", permission: "keeper" }],
        memberRows,
      }),
    ).toEqual({ read: false, write: false, delete: false });
  });

  test("相手の列を宣言せずグループだけを宣言した表でも、グループ経由で効く", () => {
    const groupOnly = manifest();
    const declaration = (tableOf(groupOnly, "books") as unknown as Record<string, unknown>)
      .access_control as Record<string, unknown>;
    declaration.grant = {
      table: "book_grant",
      target: "book",
      group: "team",
      permission: "permission",
    };
    expect(
      judgeRecordAccess({
        manifest: groupOnly,
        tableId: "books",
        row,
        actorId: "user-b",
        grantRows: [{ _id: "g-1", book: "row-1", team: "t-1", permission: "reader" }],
        memberRows,
      }),
    ).toEqual({ read: true, write: false, delete: false });
  });

  test("匿名(actor を特定できない実行)はグループ経由でも3つとも false(fail-closed)", () => {
    expect(
      judgeRecordAccess({
        manifest: base,
        tableId: "books",
        row,
        actorId: null,
        grantRows: [{ _id: "g-1", book: "row-1", team: "t-1", permission: "keeper" }],
        memberRows,
      }),
    ).toEqual({ read: false, write: false, delete: false });
  });

  test("グループ経由でも入力を1バイトも書き換えない", () => {
    const grantRows = [{ _id: "g-1", book: "row-1", team: "t-1", permission: "reader" }];
    const before = JSON.stringify({ base, row, grantRows, memberRows });
    judgeRecordAccess({
      manifest: base,
      tableId: "books",
      row,
      actorId: "user-b",
      grantRows,
      memberRows,
    });
    expect(JSON.stringify({ base, row, grantRows, memberRows })).toBe(before);
  });

  test("グループの中にグループは入らない —— 辿る段数は固定3段のままで、グループ表は実在の確認だけに読む", () => {
    // **【`V7-M3-T05` が期待値を更新した。旧文を逐語で残す。1本も削除していない】**
    //   旧題名: `test("グループの中にグループは入らない —— 辿る段数は固定3段で、判定はグループ表の行を1行も読まない", …)`
    //   旧コメント: 「**`recordAccessSourceTables` はグループ表を返さない** —— **`V7-M3-T01` は
    //     グループ表の行を1行も読まないためである**(付与行の `grant.group` と、メンバー行の
    //     `members.group` が、適用時検査によって**同じグループ表の行**を指すことが保証されている)。
    //     **【したがって残る限界】消えたグループ行を指す付与は、メンバー行が同じ id を指したまま
    //     なら今日も効く** —— **その扱いは `V7-M3-T05` の担当である。**」
    //   旧期待値: `{ grantTable: "book_grant", memberTable: "book_member" }`
    //
    // **今日**: **`recordAccessSourceTables` はグループ表も返す。** **id の一致でグループの
    // 一致が決まることは今日も変わらないが、`V7-M3-T05`(`Z-G32`)が「その行が実在するか」を
    // 見るようになったため、読む表が1本増えた。** **辿る段数は今日も固定3段で、再帰は1行も無い。**
    expect(recordAccessSourceTables(manifest(), "books")).toEqual({
      grantTable: "book_grant",
      memberTable: "book_member",
      groupTable: "book_team",
    });
  });
});

// ---------------------------------------------------------------------------
// (G) `V7-M3-T01` 完了条件 (ii): **1行が複数のユーザ・複数のグループから見える**ことを
//     `API` から示す(**画面ではない**)
//
// **`G1` に2人(`u1` / `u2`)、`G2` に1人(`u3`)、どのグループにも属さない `u4`、
//   付与も所属も無い `u5` の5人で、一覧 `GET` / 単件 `GET` / `PATCH` を叩く。**
// **1つの行に3件の付与を付ける**: `G1` へ `reader`(read のみ)/ `G2` へ `writer`
// (read+write)/ `u4` へ直接 `keeper`(read+write+delete)。
// ---------------------------------------------------------------------------

describe("V7-M3-T01 (G): HTTP —— 1行が複数のユーザ・複数のグループから見える", () => {
  let shared = "";
  let u1: ReturnType<typeof seedSession>;
  let u2: ReturnType<typeof seedSession>;
  let u3: ReturnType<typeof seedSession>;
  let u4: ReturnType<typeof seedSession>;
  let u5: ReturnType<typeof seedSession>;
  let u1Member = "";

  beforeEach(() => {
    // **5人とも `editor`** —— **ロールの差で結果が動かないようにする。**
    u1 = seedSession(dataRoot, APP_ID, { role: "editor", username: "u1" });
    u2 = seedSession(dataRoot, APP_ID, { role: "editor", username: "u2" });
    u3 = seedSession(dataRoot, APP_ID, { role: "editor", username: "u3" });
    u4 = seedSession(dataRoot, APP_ID, { role: "editor", username: "u4" });
    u5 = seedSession(dataRoot, APP_ID, { role: "editor", username: "u5" });

    const loaded = manifest();
    withDb((db) => {
      const create = (tableId: string, values: Record<string, unknown>): string => {
        const created = createRecord(db, loaded, tableId, values);
        expect(created.ok).toBe(true);
        return (created as { value: { _id: string } }).value._id;
      };
      shared = create("books", { title: "3件の付与が付いた本" });
      const g1 = create("book_team", { title: "G1" });
      const g2 = create("book_team", { title: "G2" });
      u1Member = create("book_member", { account: u1.userId, team: g1 });
      create("book_member", { account: u2.userId, team: g1 });
      create("book_member", { account: u3.userId, team: g2 });
      const u4Member = create("book_member", { account: u4.userId });
      create("book_member", { account: u5.userId });
      create("book_grant", { book: shared, team: g1, permission: "reader" });
      create("book_grant", { book: shared, team: g2, permission: "writer" });
      create("book_grant", { book: shared, member: u4Member, permission: "keeper" });
    });
  });

  async function listIds(session: ReturnType<typeof seedSession>): Promise<string[]> {
    const response = await get(`/api/apps/${APP_ID}/tables/books/records`, session.cookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { records: { _id: string }[] };
    return body.records.map((record) => record._id);
  }

  test("(完了条件 ii-1) 一覧 GET —— 4人にはその1行が返り、5人目には1件も返らない", async () => {
    for (const session of [u1, u2, u3, u4]) {
      expect(await listIds(session)).toEqual([shared]);
    }
    expect(await listIds(u5)).toEqual([]);
  });

  test("(完了条件 ii-2) 単件 GET —— 4人は 200、付与も所属も無い人は 404(存在を伏せる)", async () => {
    for (const session of [u1, u2, u3, u4]) {
      const response = await get(
        `/api/apps/${APP_ID}/tables/books/records/${shared}`,
        session.cookie,
      );
      expect(response.status).toBe(200);
    }
    const denied = await get(`/api/apps/${APP_ID}/tables/books/records/${shared}`, u5.cookie);
    expect(denied.status).toBe(404);
  });

  test("(完了条件 ii-3) PATCH —— read だけのグループは 403、write を持つグループと直接の付与は 200", async () => {
    const version = async (session: ReturnType<typeof seedSession>): Promise<string> => {
      const response = await get(
        `/api/apps/${APP_ID}/tables/books/records/${shared}`,
        session.cookie,
      );
      return response.headers.get("etag") as string;
    };
    for (const session of [u1, u2]) {
      const response = await patch(
        `/api/apps/${APP_ID}/tables/books/records/${shared}`,
        session.cookie,
        await version(session),
        { title: "書き換えたい" },
      );
      expect(response.status).toBe(403);
    }
    for (const session of [u3, u4]) {
      const response = await patch(
        `/api/apps/${APP_ID}/tables/books/records/${shared}`,
        session.cookie,
        await version(session),
        { title: `${session.userId} が書き換えた` },
      );
      expect(response.status).toBe(200);
    }
    const denied = await patch(
      `/api/apps/${APP_ID}/tables/books/records/${shared}`,
      u5.cookie,
      await version(u3),
      { title: "書き換えたい" },
    );
    expect(denied.status).toBe(404);
  });

  test("(OR の合成) グループ経由の read のみの人に直接の write を1件足すと、PATCH が通る", async () => {
    const before = await get(`/api/apps/${APP_ID}/tables/books/records/${shared}`, u1.cookie);
    const blocked = await patch(
      `/api/apps/${APP_ID}/tables/books/records/${shared}`,
      u1.cookie,
      before.headers.get("etag") as string,
      { title: "まだ書けない" },
    );
    expect(blocked.status).toBe(403);

    withDb((db) => {
      const created = createRecord(db, manifest(), "book_grant", {
        book: shared,
        member: u1Member,
        permission: "writer",
      });
      expect(created.ok).toBe(true);
    });

    const after = await get(`/api/apps/${APP_ID}/tables/books/records/${shared}`, u1.cookie);
    const allowed = await patch(
      `/api/apps/${APP_ID}/tables/books/records/${shared}`,
      u1.cookie,
      after.headers.get("etag") as string,
      { title: "OR で合成された" },
    );
    expect(allowed.status).toBe(200);
    const body = (await allowed.json()) as { record: { title: string } };
    expect(body.record.title).toBe("OR で合成された");
  });
});
