/**
 * **`V7-M3-T07` / `Z-G36`**: **行が見えない人には、その行が参照している画像・添付ファイルも
 * 配信しない。**
 *
 * **`ADR-0061` が「解かない」と明記した穴を v7 が引き取る** —— 逐語(`ADR-0061:120`):
 * 「2. **file 配信**: owner は本 ADR の前から全 file に到達できる(Context 4)。**「行は見えないが、
 * その行が参照している画像は見える」状態が既に存在する。** **本 ADR はこれを解かない。**」
 *
 * ## 構造上の難所(`v7-m0.md` §4-6 / §5-4 の (viii))
 *
 * **`src/server/app.ts` の `type FileViewer` が**ロールを1バイトも持たない**ため、
 * `isOwnerVisible` のシグネチャ変更ではこの経路を捕まえられない。** **本タスクは型ごと直した**
 * —— **`FileViewer` に「予約3ロールか」を持たせ、参照走査に判定を渡す。**
 *
 * ## 【誇張しない。本ファイルが測っていないこと】
 *
 * - **`st_public` との同居は本タスクが塞いだのではない** —— **`V7-M1-T05` の適用時検査 項目8
 *   が既に拒否している**(`v7-m0.md` §6-3b の3 の裁定)。**(F) がそれを実測するだけである。**
 * - **blob 実体はスナップショットに含まれない**(`src/kernel/snapshot.ts:73`-`:75` の逐語)。
 *   **巻き戻しの前後で動くのは判定の入力(付与)だけである** —— **1度も測っていない。**
 * - **MCP / 受信口 / ワークフロー / 島は今日も file_id を読める**(`Z-G21`〜`Z-G24`)。
 *
 * ## 追記(`V7-M3-T09` / `ADR-0296`。**上の文を1バイトも消していない**)
 *
 * **(G) を足した** —— **`V7-M3-T07` が §2-7-8 の2 で「fail-open を1つ作った。検査を1本も
 * 書いていない」と自ら記録した穴に、検査を当てる。** **マニフェストが JSON として読めないとき、
 * 予約3ロールには今日どおり file を配信する**(`app.ts` の `manifest === undefined` の枝)。
 *
 * **【この3本は「赤を採ってから直した」ものではない。正直に書く】** —— **挙動は
 * `V7-M3-T07` の時点で既にこうなっており、(G) はそれを**固定した**だけである
 * (characterization test)。**塞いだのではない。** **塞ぐなら「宣言を読めないときは誰にも
 * 配信しない」に倒すことになり、それは宣言していない表の配信を着手前から変える**
 * (= `Z-G36` の完了条件 (ii) を破る)ので、**`ADR-0296` は倒さないほうを選んだ。**
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appDbPath,
  applyManifest,
  appManifestPath,
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

const APP = "file-shelf";

function manifest(): Manifest {
  return {
    app: {
      id: APP,
      name: "蔵書(ファイル)",
      tables: [
        {
          id: "books",
          name: "書籍",
          fields: [
            { id: "title", name: "タイトル", type: "text", required: true },
            { id: "cover", name: "表紙", type: "image" },
            { id: "doc", name: "原稿", type: "file" },
          ],
          access_control: {
            enabled: true,
            permissions: [
              { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
              { id: "keeper", name: "消せる", read: true, write: true, delete: true },
            ],
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
          fields: [
            { id: "body", name: "本文", type: "text" },
            { id: "pic", name: "画像", type: "image" },
          ],
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
            { id: "permission", name: "権限", type: "select", options: ["reader", "keeper"] },
          ],
        },
      ],
      views: [],
    },
  } as unknown as Manifest;
}

/**
 * **【`V8-M26`】面(役割に束ねた権限)の既定が「閉じる」側へ倒れたので、題材へ規則を足す。**
 *
 * **`V8-M26-T03` 以降、規則を1本も名指ししていない表は拒否される。** 実アプリでは
 * `apply-diff.ts` の自動付与が `add_table` のたびに既定3役割へ規則を1本ずつ入れるが、
 * **本ファイルは `applyManifest` を直接呼ぶので差分の畳み込みを1度も通らない。**
 * `withDefaultRoleRules` は、その自動付与とまったく同じ規則を後から足すだけである。
 *
 * **`books` は `skipTables` で外す** —— **`books` は `access_control` を宣言した
 * 保護対象の表であり、面の規則を1本でも足すと `combineRoleAndGrantAccess` の `OR` で
 * 面の答えが通ってしまい、(A) 群が測っている「行ごとの付与だけで決まる」ことが
 * 丸ごと測れなくなる。** **面は閉じたままにする。**
 *
 * **開けるのは `notes`(宣言していない表)と、補助3表(`book_team` / `book_member` /
 * `book_grant`)だけである。** **(B) 群が測っているのは、その `notes` の image が
 * 予約3ロールへ今日どおり配信されることである。**
 */
function manifestWithRoles(): Manifest {
  return withDefaultRoleRules(manifest(), { skipTables: ["books"] });
}

function pngBytes(tag: number): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, tag, tag + 1, tag + 2]);
}

let dataRoot = "";
let app: ReturnType<typeof createServerApp>;

/** 運営ロール(`owner`。**付与を1件も持たない**)/ `read` の付与を持つ人 / 付与なし / customer。 */
let admin: ReturnType<typeof seedSession>;
let reader: ReturnType<typeof seedSession>;
let none: ReturnType<typeof seedSession>;
let customer: ReturnType<typeof seedSession>;

/** 宣言した表の行が参照する file(画像 / 添付)と、宣言していない表・未参照の file。 */
let coverGranted = "";
let docGranted = "";
let coverUngranted = "";
let fileNote = "";
let fileOrphan = "";

async function upload(cookie: string, data: Uint8Array): Promise<string> {
  const form = new FormData();
  form.set("file", new Blob([Uint8Array.from(data)]), "photo.png");
  const response = await app.request(
    new Request(`http://localhost/api/apps/${APP}/files`, {
      method: "POST",
      headers: { cookie, origin: TEST_ORIGIN },
      body: form,
    }),
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { file_id: string }).file_id;
}

async function deliver(fileId: string, cookie?: string): Promise<number> {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  const response = await app.request(
    new Request(`http://localhost/api/apps/${APP}/files/${fileId}`, { headers }),
  );
  return response.status;
}

function withDb<T>(run: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot, APP), { readwrite: true, create: false });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-acfd-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "蔵書(ファイル)", { app_id: APP });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP, manifestWithRoles()).valid).toBe(true);
  app = createServerApp({ dataRoot });

  admin = seedSession(dataRoot, APP, { role: "owner", username: "admin" });
  reader = seedSession(dataRoot, APP, { role: "editor", username: "reader" });
  none = seedSession(dataRoot, APP, { role: "editor", username: "none" });
  customer = seedSession(dataRoot, APP, { role: "customer", username: "customer" });

  coverGranted = await upload(admin.cookie, pngBytes(10));
  docGranted = await upload(admin.cookie, pngBytes(20));
  coverUngranted = await upload(admin.cookie, pngBytes(30));
  fileNote = await upload(admin.cookie, pngBytes(40));
  fileOrphan = await upload(admin.cookie, pngBytes(50));

  const loaded = manifest();
  withDb((db) => {
    const id = (result: unknown): string => (result as { value: { _id: string } }).value._id;
    const granted = id(
      createRecord(db, loaded, "books", {
        title: "付与のある本",
        cover: coverGranted,
        doc: docGranted,
      }),
    );
    id(createRecord(db, loaded, "books", { title: "付与の無い本", cover: coverUngranted }));
    id(createRecord(db, loaded, "notes", { body: "宣言していない表", pic: fileNote }));

    const member = (account: string): string =>
      id(createRecord(db, loaded, "book_member", { account }));
    const readerMember = member(reader.userId);
    member(none.userId);
    member(admin.userId);
    createRecord(db, loaded, "book_grant", {
      book: granted,
      member: readerMember,
      permission: "reader",
    });
  });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (A) 完了条件 (i) —— **行が見えない人(運営ロールを含む)は file を取れない(404)**
// ---------------------------------------------------------------------------

describe("V7-M3-T07 (A): 行が見えない人には file も渡らない", () => {
  test("(A-1) 付与を持つ人は、その行の image を 200 で取れる(通る側を必ず示す)", async () => {
    expect(await deliver(coverGranted, reader.cookie)).toBe(200);
  });

  test("(A-2) 付与を持つ人は、その行の file(添付)も 200 で取れる", async () => {
    expect(await deliver(docGranted, reader.cookie)).toBe(200);
  });

  test("(A-3) 付与を1件も持たない人(editor)は 404", async () => {
    expect(await deliver(coverGranted, none.cookie)).toBe(404);
    expect(await deliver(docGranted, none.cookie)).toBe(404);
  });

  test("(A-4) **運営ロール(owner)も 404** —— 付与を迂回しない(`D-V7-22`)", async () => {
    expect(await deliver(coverGranted, admin.cookie)).toBe(404);
    expect(await deliver(docGranted, admin.cookie)).toBe(404);
  });

  test("(A-5) 誰にも付与されていない行の image は、運営ロールにも 404", async () => {
    expect(await deliver(coverUngranted, admin.cookie)).toBe(404);
    expect(await deliver(coverUngranted, reader.cookie)).toBe(404);
  });

  test("(A-6) 未認証(匿名)は今日どおり 404(宣言した表に `st_public` は同居できない)", async () => {
    expect(await deliver(coverGranted)).toBe(404);
    expect(await deliver(docGranted)).toBe(404);
  });

  test("(A-7) 宣言された利用者の種類(customer)も、付与が無ければ 404", async () => {
    expect(await deliver(coverGranted, customer.cookie)).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// (B) 完了条件 (ii) —— **宣言していない表の file 配信は着手前と同一**
// ---------------------------------------------------------------------------

describe("V7-M3-T07 (B): 宣言していない表と未参照 file は着手前と同一", () => {
  test("(B-1) 宣言していない表の image は、予約3ロールに今日どおり 200", async () => {
    expect(await deliver(fileNote, admin.cookie)).toBe(200);
    expect(await deliver(fileNote, none.cookie)).toBe(200);
    expect(await deliver(fileNote, reader.cookie)).toBe(200);
  });

  // **【`V17-M4-T03d` / `AC-G21`。テスト名ごと引き直した。旧名と旧の期待値を逐語で残す】**
  // **旧名**: `test("(B-2) どのレコードからも参照されない file も、予約3ロールに今日どおり 200")`
  // **旧の期待値(逐語)**:
  //
  //     expect(await deliver(fileOrphan, admin.cookie)).toBe(200);
  //     expect(await deliver(fileOrphan, none.cookie)).toBe(200);
  //
  // **根拠**: **ユーザ決定 2026-09-08 の `D4`(「上げた本人だけ」)。**
  // **`fileOrphan` を上げたのは `admin`(`owner`)である**(`upload(admin.cookie, …)`)——
  // **`admin` の行は 200 のままで、上げていない `none`(`editor`)の行だけが 404 になった。**
  // **`ADR-0296` 限定10(「宣言していない表の file 配信を1バイトも変えない」)を
  // 引き直した先が、この1行である。**
  test("(B-2) どのレコードからも参照されない file は、上げた本人だけが 200(他は 404)", async () => {
    expect(await deliver(fileOrphan, admin.cookie)).toBe(200);
    expect(await deliver(fileOrphan, none.cookie)).toBe(404);
  });

  test("(B-3) 宣言していない表の image は、customer / 匿名に今日どおり 404", async () => {
    // **`notes` は `st_public` も `st_owner` も持たない運営テーブルである。**
    expect(await deliver(fileNote, customer.cookie)).toBe(404);
    expect(await deliver(fileNote)).toBe(404);
  });

  test("(B-4) 存在しない file_id は今日どおり 404(列挙耐性)", async () => {
    expect(await deliver("00000000-0000-4000-8000-000000000000", admin.cookie)).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// (C) 完了条件 (iii) —— **`app.ts` の該当逐語を同じ差分で直してある**
// ---------------------------------------------------------------------------

describe("V7-M3-T07 (C): `app.ts` の逐語が今日の正になっている", () => {
  test("(C-1) 旧の逐語は消さずに残っていて、「旧」と明記されている", async () => {
    const source = await Bun.file(join(PRODUCT_ROOT, "src", "server", "app.ts")).text();
    const old = "owner/editor/viewer は全 file なのでこの判定を通さない。";
    expect(source.includes(old)).toBe(true);
    // **旧文の直前に「旧:」が在る** = **今日の主張として書かれていない。**
    const at = source.indexOf(old);
    const before = source.slice(Math.max(0, at - 400), at);
    expect(before.includes("**旧**")).toBe(true);
  });

  test("(C-2) 今日の正が書かれている(予約3ロールも判定を通る)", async () => {
    const source = await Bun.file(join(PRODUCT_ROOT, "src", "server", "app.ts")).text();
    expect(source.includes("予約3ロールもこの判定を通る")).toBe(true);
  });

  // **【`V8-M27-T04` / `T-G5`。期待値を反転させた。旧のテスト名と旧の期待値を逐語で残す】**
  // **旧のテスト名**: `(C-3) \`FileViewer\` 型がロールを持っている(型ごと直した)`
  // **旧の期待値(逐語)**: `expect(declaration.includes("reservedRole")).toBe(true);`
  // **根拠**: **`V8-M27` / 台帳 `T-G5` / ユーザ決定 `D-V8-38`。**
  // **`V7-M3-T07` が持たせた `reservedRole` は「予約3ロールか」の1ビットであり、
  // まさに撤去対象の層そのものだった** —— **今日 `FileViewer` はロールを1バイトも持たない。**
  // **「ロールの綴りを1文字も持たせない」(`ADR-0295` 限定4)は今日も真であり、
  // その主張はむしろ強くなった**(**綴りどころか、ロールの有無も持たない**)。
  test("(C-3 の反転) `FileViewer` 型はロールを1バイトも持たない(V8-M27 が層ごと外した)", async () => {
    const source = await Bun.file(join(PRODUCT_ROOT, "src", "server", "app.ts")).text();
    const at = source.indexOf("type FileViewer =");
    expect(at).toBeGreaterThan(0);
    const declaration = source.slice(at, source.indexOf("\n\n", at));
    expect(declaration.includes("reservedRole")).toBe(false);
    // **ロールの綴りも1文字も持たせていない**(`ADR-0295` 限定4。**据え置き**)。
    for (const role of ['"owner"', '"editor"', '"viewer"', '"customer"']) {
      expect(declaration).not.toContain(role);
    }
  });
});

// ---------------------------------------------------------------------------
// (F) **`access_control` と `st_public` の同居は、本タスクが実装したのではない**
//     `V7-M1-T05` の適用時検査 項目8 が既に拒否している(`v7-m0.md` §6-3b の3)
// ---------------------------------------------------------------------------

describe("V7-M3-T07 (F): `st_public` との同居は適用時に拒否される(既存の実装)", () => {
  test("(F-1) 宣言した表に `st_public` を足した宣言は、適用時に拒否される", () => {
    const collided = manifest();
    const books = collided.app.tables.find((table) => table.id === "books");
    if (books === undefined) {
      throw new Error("フィクスチャが壊れている");
    }
    (books.fields as unknown[]).push({ id: "st_public", name: "公開", type: "boolean" });
    const result = applyManifest(dataRoot, APP, collided);
    expect(result.valid).toBe(false);
    const messages = (result as { errors: { message: string }[] }).errors.map(
      (error) => error.message,
    );
    expect(messages.some((message) => message.includes("st_public"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (G) **`V7-M3-T09` / `ADR-0296` が足した** —— **マニフェストが読めないときの fail-open**
//     `V7-M3-T07` が §2-7-8 の2 で「検査を1本も書いていない」と自認した穴を固定する。
//     **塞いだのではない。** **今日の挙動をそのまま検査に落としただけである。**
// ---------------------------------------------------------------------------

describe("V7-M3-T09 (G): マニフェストが読めないときの fail-open(`ADR-0296` §限界)", () => {
  /** アプリのマニフェストを JSON として読めない中身に置き換える(ディスク上の1ファイルだけ)。 */
  async function corruptManifest(): Promise<void> {
    await writeFile(appManifestPath(dataRoot, APP), "{ 壊れた JSON", "utf-8");
  }

  // =====================================================================================
  // **【`V8-M27-T04` / ユーザ決定 `D-V8-73`(2026-08-11)。期待値を反転させた。
  //   旧のテスト名と旧の期待値を逐語で残す】**
  //
  // **旧のテスト名と旧の期待値**:
  //   `(G-1) 壊れる前は 404 だった行の image が、壊れたあとは運営ロールに 200 で配信される`
  //       expect(await deliver(coverGranted, admin.cookie)).toBe(200);
  //   `(G-2) 付与を1件も持たない editor / viewer にも配信される(予約3ロールの全部)`
  //       expect(await deliver(coverGranted, none.cookie)).toBe(200);
  //       expect(await deliver(coverGranted, viewer.cookie)).toBe(200);
  //
  // **`D-V8-73` の選ばれた説明文の逐語**:
  // > 「定義が読めないときは、画像や添付ファイルを誰にも配りません。この軸の
  // >  「書いていなければ見えない」と向きが揃いますが、**定義が壊れたときに運営が
  // >  中身を確かめる手段が1つ減ります**。」
  //
  // **したがって fail-open は fail-closed になった。** **この describe 名の
  // 「fail-open」は旧の呼び名であり、1バイトも書き換えていない**(下の3本が今日の姿を測る)。
  // **`ADR-0296` §限界 が申告していた穴は、この決定で塞がった** ——
  // **代償(壊れた日に運営が中身を確かめられない)は上の逐語のとおりである。**
  // =====================================================================================
  test("(G-1 の反転) 壊れたあとも運営ロールに配信されない(D-V8-73 = fail-closed)", async () => {
    // **壊れる前**: (A-4) と同じ —— 付与を迂回しないので運営ロールにも 404。
    expect(await deliver(coverGranted, admin.cookie)).toBe(404);
    await corruptManifest();
    expect(await deliver(coverGranted, admin.cookie)).toBe(404);
  });

  test("(G-2 の反転) 付与を1件も持たない editor / viewer にも配信されない(予約3ロールの全部)", async () => {
    const viewer = seedSession(dataRoot, APP, { role: "viewer", username: "viewer-g2" });
    await corruptManifest();
    expect(await deliver(coverGranted, none.cookie)).toBe(404);
    expect(await deliver(coverGranted, viewer.cookie)).toBe(404);
  });

  // **【`V8-M27-T04` / `D-V8-73`】この1本だけは期待値が1バイトも変わっていない** ——
  // **旧は「fail-open が予約3ロールに閉じている」ことを測っており、今日は
  // 「誰にも配らない」の一部として同じ 404 になる。** **旧のテスト名は残す。**
  test("(G-3) 匿名と customer には配信されない(fail-open は予約3ロールに閉じている)", async () => {
    await corruptManifest();
    expect(await deliver(coverGranted)).toBe(404);
    expect(await deliver(coverGranted, customer.cookie)).toBe(404);
  });
});
