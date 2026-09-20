/**
 * **`V7-M3-T06` / `Z-G34` + `Z-G25`**: **`DELETE` に「消す」を効かせ、境界を書く。**
 *
 * ## 関門の順序(`v7-m0.md` §5-4 の (vi)。**この順序を守る**)
 *
 * **(1) 所有者スコープの 404 →(2) 付与の可視性 404 →(3) 付与の「消す」403 →(4) 削除保護 409**
 *
 * - **(1)(2) はどちらも「存在を伏せる」層なので隣に置く。** 理由の逐語は `app.ts` の既存
 *   コメント(「**他人の守られた行に 409 を返すと『守られた行がそこに在る』ことが漏れる**
 *   からで、個人スコープの 404(存在を伏せる)が先に立つ必要がある」)。
 * - **(3) を (4) より前に置くのは、見えている行に対して「あなたには消す権限が無い」と言う
 *   ほうが「この行は消せません」より正確だからである。**
 *
 * ## 境界(`Z-G25` の中身。**実装と記録の両方に書く**)
 *
 * - **`judgeRoleFieldWrite` を `DELETE` に1バイトも配線していない**(`v7-m0.md` §5-9)——
 *   **`ADR-0076` §3a-2 が門にしているのは「項目単位の判定を `DELETE` に掛ける」提案であり、
 *   v7 が掛けるのは行単位の判定で項目を1つも見ない。**
 * - **`isRoleActionWriteAllowed` も今日どおり `DELETE` に掛からない。**
 * - **【`V8-M20` / 台帳 `J-G28` `J-G29` / `ADR-0301`】この2つは綴りが変わった** ——
 *   **旧 `judgeFieldWrite` / `isViewActionWriteAllowed`。** **宣言 `field.writable_by` /
 *   `view_action.audience` を廃し、面の規則(役割 × 対象 × 動詞)で判定するようになった。**
 *   **`DELETE` に掛からないという境界そのものは1ミリも動いていない。**
 * - **この2点は (E) が機械的に固定する**(`DELETE` ハンドラの中にこの2つの綴りが1件も無い)。
 *
 * ## 【誇張しない。本ファイルが測っていないこと】
 *
 * - **`DELETE` 経路は今日もトランザクションを1つも開かない**(`app.ts` の逐語)。
 *   **関門を1本増やしても TOCTOU の窓は残る。** **本タスクは解決していない。**
 * - **MCP / 受信口 / ワークフロー / コードの島は今日も同じ行を消せる**(`Z-G21`〜`Z-G24`)。
 *   **「この行は守られている」とは書かない。**
 * - **`POST` / `PATCH` について、3本の書込制御(項目単位の書込判定 / 操作起点の壁 /
 *   行の権限)の順序を決めていない**(`v7-m0.md` §5-9 / `ADR-0249:280`)。
 *   **決めたのは `DELETE` だけである。**
 *   **【`V8-M20`】1本目は旧 `field.writable_by` の宣言で、今日は面の規則である
 *   (`judgeRoleFieldWrite`)。** **順序を決めていないことは今日も変わらない。**
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

/**
 * 移した公開単位の根(`apps/smailtalk/`)。**`import.meta.dir` から数える** ——
 * cwd 相対で解くと `bun test` を打つ場所で結果が変わる(`src/` はもうルート直下に無い)。
 */
const PRODUCT_ROOT = join(import.meta.dir, "..", "..");

const APP_ID = "delete-shelf";

/** 権限名3つ。**`delete` を持つのは `keeper` だけである。** */
const PERMISSIONS = [
  { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
  { id: "writer", name: "編集できる", read: true, write: true, delete: false },
  { id: "keeper", name: "消せる", read: true, write: true, delete: true },
] as const;

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "蔵書(削除)",
      tables: [
        {
          id: "books",
          name: "書籍",
          fields: [
            { id: "title", name: "タイトル", type: "text", required: true },
            // **削除保護(`ADR-0073`)と同居させる** —— **関門 (3) と (4) の順序を測るため。**
            { id: "st_undeletable", name: "消せない", type: "boolean" },
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
          // **宣言していない表**(オプトインの対照。ここは着手前と1バイトも変わらない)。
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
 * 1本でも足すと {@link combineRoleAndGrantAccess} の `OR` で全員が通ってしまい、
 * この検査の主題(**行ごとの付与だけで可否が決まること**)が丸ごと測れなくなる。**
 *
 * **`notes` にだけ手書きの規則を置く** —— **既定の自動付与は `editor` に `delete` を
 * 配らないが、(D-1) は「宣言していない表の DELETE が `editor` で 204」を測っている。**
 */
function manifestWithRoles(): Manifest {
  const base = manifest() as unknown as { app: Record<string, unknown> };
  base.app.roles = [
    { id: "owner", name: "持ち主" },
    {
      id: "editor",
      name: "編集者",
      rules: [{ target: "table", table: "notes", can: ["read", "write", "delete"] }],
    },
    { id: "viewer", name: "閲覧者" },
  ];
  return withDefaultRoleRules(base as unknown as Manifest, { skipTables: ["books"] });
}

let dataRoot = "";
let app: ReturnType<typeof createServerApp>;

/** 付与なし(`editor`)/ `reader` の付与 / `keeper` の付与 / **運営ロール**(`owner`)。 */
let none: ReturnType<typeof seedSession>;
let reader: ReturnType<typeof seedSession>;
let keeper: ReturnType<typeof seedSession>;
let admin: ReturnType<typeof seedSession>;

/** 3人に付与のある行 / 付与の無い行 / 削除保護の立った行 / 宣言していない表の行。 */
let shared = "";
let ungranted = "";
let protectedRow = "";
let noteId = "";

function withDb<T>(run: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    return run(db);
  } finally {
    db.close();
  }
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

async function del(
  path: string,
  cookie: string,
  ifMatch: string,
): Promise<{ status: number; message: string }> {
  const response = await app.request(path, {
    method: "DELETE",
    headers: { cookie, origin: TEST_ORIGIN, "if-match": ifMatch },
  });
  if (response.status === 204) {
    return { status: 204, message: "" };
  }
  const body = (await response.json()) as { errors?: { message: string }[] };
  return { status: response.status, message: body.errors?.[0]?.message ?? "" };
}

function rowCount(table: string): number {
  return withDb((db) => (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-acd-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "蔵書(削除)", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, manifestWithRoles()).valid).toBe(true);
  app = createServerApp({ dataRoot });

  // **3人は `editor`、1人は `owner`** —— **運営ロールが付与を迂回しないことを測るため**
  // (`D-V7-22` / `ADR-0295` 限定1)。
  none = seedSession(dataRoot, APP_ID, { role: "editor", username: "none" });
  reader = seedSession(dataRoot, APP_ID, { role: "editor", username: "reader" });
  keeper = seedSession(dataRoot, APP_ID, { role: "editor", username: "keeper" });
  admin = seedSession(dataRoot, APP_ID, { role: "owner", username: "admin" });

  const loaded = manifest();
  withDb((db) => {
    const id = (result: unknown): string => (result as { value: { _id: string } }).value._id;
    shared = id(createRecord(db, loaded, "books", { title: "3人に付与のある本" }));
    ungranted = id(createRecord(db, loaded, "books", { title: "誰にも付与の無い本" }));
    protectedRow = id(
      createRecord(db, loaded, "books", { title: "消せない本", st_undeletable: true }),
    );
    noteId = id(createRecord(db, loaded, "notes", { body: "宣言していない表" }));

    // **4人ともメンバー表に行を持つ** —— **「付与が無い」と「メンバー行が無い」を分ける。**
    const member = (account: string): string =>
      id(createRecord(db, loaded, "book_member", { account }));
    member(none.userId);
    const readerMember = member(reader.userId);
    const keeperMember = member(keeper.userId);
    member(admin.userId);

    const grant = (bookId: string, memberId: string, permission: string): void => {
      const created = createRecord(db, loaded, "book_grant", {
        book: bookId,
        member: memberId,
        permission,
      });
      expect(created.ok).toBe(true);
    };
    grant(shared, readerMember, "reader");
    grant(shared, keeperMember, "keeper");
    // **削除保護の立った行には `keeper` を付ける** —— **(3) を通過させて (4) に当てるため。**
    grant(protectedRow, keeperMember, "keeper");
    // **`reader` にも同じ行を付ける** —— **(3) が (4) より前であることを測るため。**
    grant(protectedRow, readerMember, "reader");
  });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (A) 完了条件 (a) —— **「消す」を含まない権限名しか持たない人の DELETE が拒否される**
// ---------------------------------------------------------------------------

describe("V7-M3-T06 (A): 「消す」を持たない人の DELETE は 403", () => {
  test("(A-1) read だけを持つ人の DELETE は 403 で、行は1件も減っていない", async () => {
    const before = rowCount("books");
    const response = await del(
      `/api/apps/${APP_ID}/tables/books/records/${shared}`,
      reader.cookie,
      versionOf("books", shared),
    );
    expect(response.status).toBe(403);
    expect(rowCount("books")).toBe(before);
  });

  test("(A-2) 文言に内部記号が1文字も無い(利用者の言葉である)", async () => {
    const response = await del(
      `/api/apps/${APP_ID}/tables/books/records/${shared}`,
      reader.cookie,
      versionOf("books", shared),
    );
    expect(response.status).toBe(403);
    expect(response.message.length).toBeGreaterThan(0);
    for (const symbol of ["access_control", "Z-G", "judgeRecordAccess", "delete", "books"]) {
      expect(response.message).not.toContain(symbol);
    }
  });
});

// ---------------------------------------------------------------------------
// (B) 完了条件 (b) —— **「消す」を持つ人の DELETE は今日どおり通る**
//     **拒否側だけを示すと「全部拒否」でも緑になるので、通る側を必ず測る。**
// ---------------------------------------------------------------------------

describe("V7-M3-T06 (B): 「消す」を持つ人の DELETE は 204 のまま", () => {
  test("(B-1) keeper の DELETE は 204 で、行が1件減る", async () => {
    const before = rowCount("books");
    const response = await del(
      `/api/apps/${APP_ID}/tables/books/records/${shared}`,
      keeper.cookie,
      versionOf("books", shared),
    );
    expect(response.status).toBe(204);
    expect(rowCount("books")).toBe(before - 1);
  });
});

// ---------------------------------------------------------------------------
// (C) 関門の順序(`v7-m0.md` §5-4 の (vi))を4段とも実測する
// ---------------------------------------------------------------------------

describe("V7-M3-T06 (C): 関門の順序 —— (2) 可視性 404 →(3) 「消す」403 →(4) 削除保護 409", () => {
  test("(C-2) 付与の無い人の DELETE は 404(403 ではない。存在を伏せる側が先)", async () => {
    const response = await del(
      `/api/apps/${APP_ID}/tables/books/records/${shared}`,
      none.cookie,
      versionOf("books", shared),
    );
    expect(response.status).toBe(404);
  });

  test("(C-2b) 付与の無い行は、付与を持っている人からも 404", async () => {
    const response = await del(
      `/api/apps/${APP_ID}/tables/books/records/${ungranted}`,
      keeper.cookie,
      versionOf("books", ungranted),
    );
    expect(response.status).toBe(404);
  });

  test("(C-2c) 運営ロール(owner)でも、付与の無い行は 404(運営は付与を迂回しない)", async () => {
    const response = await del(
      `/api/apps/${APP_ID}/tables/books/records/${ungranted}`,
      admin.cookie,
      versionOf("books", ungranted),
    );
    expect(response.status).toBe(404);
    expect(rowCount("books")).toBe(3);
  });

  test("(C-3→4) 「消す」を持つ人が削除保護の立った行を消そうとすると 409(3段目を通って4段目で止まる)", async () => {
    const response = await del(
      `/api/apps/${APP_ID}/tables/books/records/${protectedRow}`,
      keeper.cookie,
      versionOf("books", protectedRow),
    );
    expect(response.status).toBe(409);
  });

  test("(C-3先) 同じ行でも、「消す」を持たない人には 409 ではなく 403 が返る(順序が (3)→(4) である証拠)", async () => {
    // **これが順序の実証である** —— **(4) が先だったら、この人にも 409 が返る。**
    const response = await del(
      `/api/apps/${APP_ID}/tables/books/records/${protectedRow}`,
      reader.cookie,
      versionOf("books", protectedRow),
    );
    expect(response.status).toBe(403);
  });

  test("(C-2先) 付与の無い人には、削除保護の立った行も 404(守られた行が在ることを漏らさない)", async () => {
    const response = await del(
      `/api/apps/${APP_ID}/tables/books/records/${protectedRow}`,
      none.cookie,
      versionOf("books", protectedRow),
    );
    expect(response.status).toBe(404);
  });

  /*
   * **【`V18-M7-T02` / `PM-G5` / `ADR-0444` 授権の表 行18 が足した **7本目**】**
   *
   * **上の6本(4段)の期待値を1つも触っていない。** **足したのは、その4段の**後ろ**に
   * 置いた5本目の関門 —— **親を消すと残る子の連鎖** —— の位置である。**
   *
   * ## **なぜ位置を綴りで測るのか(振る舞いで測っていないことを隠さない)**
   *
   * **本ファイルの題材(`books`)は子を1本も持たない** —— **子を作るには表を1本足すことに
   * なり、(F-1) が `toEqual(["books"])` で固定している「宣言した表の一覧」が動く。**
   * **`ADR-0444` 授権の表 行18 が許したのは (C) の組み直しだけであり、(F) は射程外である。**
   * **したがって本ファイルは**位置**だけを固定し、**振る舞い**は
   * `src/server/parent-delete-cascade-route.test.ts` の (G) が別の題材で撃つ。**
   *
   * ## **この1本が守っているもの**
   *
   *  1. **新しい関門が既存の関門より**後ろ**に在ること** —— **前に置くと、見えない行の
   *     件数を漏らす**(`ADR-0434` §Decision 6 の 5 の「越えてはならない線」)。
   *  2. **「消せない子が在る」の断りが、「件数の印が無い」の断りより**先**に在ること**
   *     (`ADR-0444` §Decision 3 の ③ が ④ より先)—— **逆にすると、自分に消せない行の
   *     件数と表IDを先に返してしまう。**
   */
  test("(C-7) 子の連鎖の関門は、既存の関門の後ろ・実際に消す手前に在り、③ が ④ より先である", async () => {
    const body = await deleteHandlerBody();
    const cascadeAt = body.indexOf("resolveRecordDeleteCascade(");
    const grantAt = body.indexOf("grantWriteVerdict(");
    // **親そのものを消す呼び出しは、このハンドラの中で**いちばん最後**の書込である。**
    const parentWriteAt = body.lastIndexOf("writeWithAudit(");
    expect(cascadeAt).toBeGreaterThan(0);
    expect(grantAt).toBeGreaterThan(0);
    expect(parentWriteAt).toBeGreaterThan(0);
    expect(cascadeAt).toBeGreaterThan(grantAt);
    expect(cascadeAt).toBeLessThan(parentWriteAt);
    // **③(消せない子が在る)は ④(件数の印)より先に立つ。**
    const undeletableAt = body.indexOf("hasUndeletableChild");
    const sealAt = body.indexOf("if-match-children");
    expect(undeletableAt).toBeGreaterThan(0);
    expect(sealAt).toBeGreaterThan(0);
    expect(undeletableAt).toBeLessThan(sealAt);
  });
});

// ---------------------------------------------------------------------------
// (D) 完了条件 (c) —— **宣言していない表の DELETE の応答は着手前と同一**
// ---------------------------------------------------------------------------

describe("V7-M3-T06 (D): 宣言していない表は着手前と同一", () => {
  test("(D-1) 宣言していない表の DELETE は、付与を1件も持たない人でも 204", async () => {
    const response = await del(
      `/api/apps/${APP_ID}/tables/notes/records/${noteId}`,
      none.cookie,
      versionOf("notes", noteId),
    );
    expect(response.status).toBe(204);
    expect(rowCount("notes")).toBe(0);
  });

  test("(D-2) 宣言していない表の DELETE は、If-Match が無ければ今日どおり 400", async () => {
    const response = await app.request(`/api/apps/${APP_ID}/tables/notes/records/${noteId}`, {
      method: "DELETE",
      headers: { cookie: none.cookie, origin: TEST_ORIGIN },
    });
    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// (E) 完了条件 (e) —— **境界。`judgeFieldWrite` と `isViewActionWriteAllowed` は
//     今日も `DELETE` に掛からない**(`Z-G25`)
// ---------------------------------------------------------------------------

/** `app.ts` の経路登録行を拾って、`DELETE` ハンドラの本文だけを切り出す。 */
async function deleteHandlerBody(): Promise<string> {
  const source = await Bun.file(join(PRODUCT_ROOT, "src", "server", "app.ts")).text();
  const pattern = /\bapp\.(get|post|patch|delete|put|all|options|head)\("([^"]+)"/g;
  const registrations: { index: number; key: string }[] = [];
  let match = pattern.exec(source);
  while (match !== null) {
    registrations.push({
      index: match.index,
      key: `${(match[1] as string).toUpperCase()} ${match[2] as string}`,
    });
    match = pattern.exec(source);
  }
  const at = registrations.findIndex(
    (registration) =>
      registration.key === "DELETE /api/apps/:app_id/tables/:table_id/records/:record_id",
  );
  if (at < 0) {
    throw new Error("DELETE の経路が app.ts に見つからない");
  }
  return source.slice(registrations[at]?.index ?? 0, registrations[at + 1]?.index ?? source.length);
}

// **【`V8-M20` / 台帳 `J-G28` `J-G29` / `ADR-0301`】判定の綴りが2本とも置き換わった。**
// **項目単位の書込判定 `judgeFieldWrite` → `judgeRoleFieldWrite`(旧 `field.writable_by` の
//   宣言を廃し、面の規則 = 役割 × 対象(項目)× 書込 で判定する)。**
// **操作起点の壁 `isViewActionWriteAllowed` → `isRoleActionWriteAllowed`(旧
//   `view_action.audience` の宣言を廃し、面の規則 = 役割 × 対象(表)× 書込 で判定する)。**
// **この (E) 群の趣旨(= **項目単位の判定と操作起点の壁は `DELETE` に1バイトも掛からない**)は
//   今日も生きているので、検査は1本も消さず、綴りだけを新しい2本へ置き直した。**
describe("V7-M3-T06 (E): 境界 —— 項目単位の判定と操作起点の壁は DELETE に1バイトも掛からない", () => {
  // **旧のテスト名: 「(E-1) DELETE ハンドラの中に judgeFieldWrite の綴りが1件も無い(…)」。**
  test("(E-1) DELETE ハンドラの中に judgeRoleFieldWrite の綴りが1件も無い(`ADR-0076` §3a-2)", async () => {
    const body = await deleteHandlerBody();
    expect(body.includes("judgeRoleFieldWrite")).toBe(false);
  });

  // **旧のテスト名: 「(E-2) DELETE ハンドラの中に isViewActionWriteAllowed の綴りが1件も無い(…)」。**
  test("(E-2) DELETE ハンドラの中に isRoleActionWriteAllowed の綴りが1件も無い(`ADR-0249` 限定1)", async () => {
    const body = await deleteHandlerBody();
    expect(body.includes("isRoleActionWriteAllowed")).toBe(false);
  });

  test("(E-3) その2つは今日も `POST` / `PATCH` / バッチにだけ在る(消えていないことの裏)", async () => {
    const source = await Bun.file(join(PRODUCT_ROOT, "src", "server", "app.ts")).text();
    const count = (needle: string): number => source.split(`${needle}(`).length - 1;
    // **`judgeRoleFieldWrite(` は 3箇所(`POST` / `PATCH` / バッチ)、
    //   `isRoleActionWriteAllowed(` も 3箇所である**(`V8-M20` の実測。本数は着手前と同じ)。
    // **旧: `count("judgeFieldWrite")` / `count("isViewActionWriteAllowed")` で
    //   `{ fieldWrite: 3, viewActionWall: 3 }`。** **綴りを置き直しても 3 / 3 のままである。**
    expect({
      fieldWrite: count("judgeRoleFieldWrite"),
      viewActionWall: count("isRoleActionWriteAllowed"),
    }).toEqual({ fieldWrite: 3, viewActionWall: 3 });
  });

  test("(E-4) DELETE ハンドラは行ごとのアクセス権を呼んでいる(境界の反対側)", async () => {
    const body = await deleteHandlerBody();
    expect(body.includes("recordAccessJudge(") || body.includes("judgeRecordAccess(")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (F) 完了条件 (d) —— **`ADR-0249` 限定1 との「並立」**(`v7-m0.md` §5-9)
//
// **2本は別の表に当たる。** **重ねなければ交わらない** —— **交わらないことを機械で確かめる。**
// ---------------------------------------------------------------------------

describe("V7-M3-T06 (F): `ADR-0249` 限定1 と並立する(重なる表を作っていない)", () => {
  // **【`V8-M20` / 台帳 `J-G29` / `ADR-0301`】操作起点の壁の宣言先が変わった。**
  // **旧: `view.actions[].audience`(ボタンの「見せる相手」)。**
  // **新: 面の規則 `app.roles[].rules[]` の `{ target: "action", view, action }` と
  //   `{ target: "table", table, can: ["write"] }`。**
  // **旧のテスト名: 「(F-1) 本フィクスチャでは、宣言した表と操作起点の `audience` を宣言した表が
  //   1つも重ならない」。** **測る趣旨(2本が交わらないこと)は1ミリも変えていないので、
  //   検査は消さずに面の側の綴りへ置き直した。**
  // **【誇張しない】** **本フィクスチャは `app.roles` を1本も書いていないので、`walled` は
  //   今日も空である。** **「重ならない」を積極的に示している検査ではなく、
  //   「重なる表をフィクスチャに作っていない」ことの固定である**(旧も同じだった)。
  test("(F-1) 本フィクスチャでは、宣言した表と操作起点の壁(面の規則)を持つ表が1つも重ならない", () => {
    const source = manifest();
    const governed = source.app.tables
      .filter(
        (table) =>
          (table as unknown as { access_control?: { enabled?: boolean } }).access_control
            ?.enabled === true,
      )
      .map((table) => table.id);
    const views = source.app.views as unknown as { id?: string; table?: string }[];
    const roles =
      (
        source.app as unknown as {
          roles?: { rules?: { target?: string; view?: string; table?: string }[] }[];
        }
      ).roles ?? [];
    // **面の規則が「ボタン」または「表 × 書込」で名指しした表** = **今日の「壁の立った表」。**
    const walled = roles
      .flatMap((role) => role.rules ?? [])
      .flatMap((rule) => {
        if (rule.target === "action") {
          return [views.find((view) => view.id === rule.view)?.table ?? ""];
        }
        if (rule.target === "table") {
          return [rule.table ?? ""];
        }
        return [];
      })
      .filter((id) => id !== "");
    expect(governed).toEqual(["books"]);
    expect(walled).toEqual([]);
    expect(governed.filter((id) => walled.includes(id))).toEqual([]);
  });

  test("(F-2) `ADR-0249` 限定1 の検査が測っている表は、`access_control` を1つも宣言していない", async () => {
    // **`ADR-0249` 限定1 の検査欄の逐語**: 「**壁の立った表**に対する `GET` / `DELETE` の
    // 応答が着手前と同値であることの HTTP 検査」。**その検査は
    // `src/server/view-action-write-wall.test.ts` の (H-4) / (H-5) である。**
    // **同ファイルに `access_control` の綴りが1件も無い** = **測っている表は宣言していない表
    // であり、v7 の判定は1バイトも当たらない。** —— **これが「並立」の機械的な実体である。**
    const wall = await Bun.file(
      join(PRODUCT_ROOT, "src", "server", "view-action-write-wall.test.ts"),
    ).text();
    expect(wall.includes("access_control")).toBe(false);
    expect(wall.includes("(H-5) 壁の立った表への DELETE は今日どおり通る")).toBe(true);
  });
});
