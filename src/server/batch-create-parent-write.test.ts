/**
 * **`V15-M3-T01` / `CR-G5`(`ADR-0404`)**:
 * **まとめ書き(`POST /api/apps/:app_id/batch`)にも、単件 `POST` とまったく同じ
 * 「親の行に書けるか」の関門を掛ける。**
 *
 * ## 何を測るか(`docs/plan/v15/04-v15-m3-tasks.md` `V15-M3-T01` の表の逐語)
 *
 * **実 HTTP で叩く**(既存の `access-control-*.test.ts` / `create-parent-write.test.ts` と
 * 同じ作法)。**題材(マニフェスト・利用者・付与・鎖・件数の台)は
 * `src/server/create-parent-write.test.ts` と同一である** —— **違うのは「どの口を撃つか」
 * だけであり、本ファイルは要求をすべて `POST /api/apps/:app_id/batch` へ送る。**
 *
 * | # | 何を撃つか | 期待 | 着手時 |
 * | --- | --- | --- | --- |
 * | `(a-1)` | 親に `write` を持つ人の作成 op 1件 | 200(今日どおり通る) | **緑**(陰性対照) |
 * | `(a-2)` | 親に `read` しか無い人の作成 op 1件 | `403` | 赤 |
 * | `(a-3)` | 親に付与を1件も持たない人の作成 op 1件 | `403` | 赤 |
 * | `(a-4)` | 持ち主(`owner`)で親に `write` が無い作成 op 1件 | `403` | 赤 |
 * | `(b-1)` | `inherit_from` を宣言していない表への作成 op | 今日どおり通る | **緑**(陰性対照) |
 * | `(b-2)` | 権限の宣言を持たない表への作成 op | 今日どおり通る | **緑**(陰性対照) |
 * | `(c-1)` | 親の表が権限を宣言していない | `403` | 赤 |
 * | `(d-1)` | 段数の上限に当たる鎖 | `400` + 上限の文面(段数) | 赤 |
 * | `(d-2)` | 行数の上限に当たる鎖 | `400` + 上限の文面(件数) | 赤 |
 * | `(e-1)` | 断り文に内部記号が1文字も無い | —— | 赤 |
 * | `(p-1)` | 通る op と親に書けない op を混ぜる | `403` + 部分適用ゼロ | 赤 |
 * | `(p-2)` | 同じ要求の中で親を作り、その親を指す子を作る | `403` + 部分適用ゼロ | 赤 |
 * | `(q-1)` | 単件 `POST` とまとめ書きが同じ答えを返す | 一致 | 赤 |
 *
 * **表は13行で、うち赤と宣言したのは10本、陰性対照は3本である**
 * (`(a-1)` / `(b-1)` / `(b-2)`)。
 * **【葉タスクとの食い違いを丸めない】** —— **`04-v15-m3-tasks.md` の `T01` の完了条件は
 * 「赤にすると宣言した9本」と書いているが、同じ葉タスクの表は10行を赤と宣言している。**
 * **葉タスク自身が「表の側を正とする」と定めているので、正は10である**
 * (`V15-M2` でまったく同じ食い違いが起きた先例がある。`v15-m2.md` §6 の 1)。
 *
 * ## **`(p-2)` は葉タスクが想定した形では書けない(実測して分かったこと)**
 *
 * **葉タスクは「同じ要求の中で親を作り、**その親を指す**子を作る」と書いているが、
 * まとめ書きでは同じ要求の中で作った行を名指しできない** —— **`_id` はカーネルが管理する
 * システム列であり、`values` に書くと `400` で拒まれる**(実測。逐語:
 * `"_id" はカーネルが管理するシステム列なので書き込めません。`)。
 * **したがって「その親を指す」を字義どおりに書く手が1つも無い。**
 * **本ファイルは、親を作る op と、**まだディスクに無い id** を指す子の op を並べる形で
 * 測っている** —— **測っている中身(判定はすべて tx を開く前に行われるので、同じ要求の中で
 * 作った親は判定からは見えない / 部分適用が起きない)は葉タスクの意図どおりである。**
 *
 * ## **【誇張しない。本ファイルが測っていないこと】**
 *
 *  1. **`update` op / `delete` op には1バイトも掛からない**(関門は `create` op だけを見る)。
 *  2. **MCP / 受信口 / ワークフロー / 島は1度も通していない** —— **`D-V15-3` が
 *     射程外にしたので、その4経路は今日も素通りする**(`ADR-0404` `S3` (1) の7)。
 *  3. **親を指していない行(参照が空)には、まとめ書きでも壁が1ミリも掛からない** ——
 *     **`create-parent-write.test.ts` の `(b-3)` が単件で固定している穴と同じものである。**
 *     **本ファイルはその穴を測り直していない**(`ADR-0404` §6 の 6)。
 *  4. **性能を1件も測っていない。** **行の読み手はループの外で1度だけ作るので op 数に
 *     比例して読み直さないが、それを**数として**測ってはいない。**
 *  5. **画面を1枚も開いていない**(`V15-M6` の担当)。
 *
 * **【`V15-M8` による訂正。上の5項を1バイトも消していない】** —— **1 の前半は今日は
 * 偽である。** **`V15-M8`(`CR-G9` / `ADR-0408`。ユーザ決定 `D-V15-11` の逐語「今回塞ぐ」)が
 * まとめ書きの `update` op にも同じ関門を配線した** —— **効くのは「要求が親の参照の値を
 * **変える**とき」だけで、参照を1文字も変えない `update` op には今日も1ミリも掛からない。**
 * **`delete` op には今日も1バイトも掛かっていない**(`ADR-0408` §6 の 2)。
 * **【この1行が穴として読まれていなかったことを記録する】** —— **本ファイルの1 は
 * `V15-M3` が**射程の注記**として書いたものであり、`CP-V15` の独立点検が
 * `create-parent-write.test.ts` の `(i-2)` として実物で再現するまで、
 * 「2手で壁の内側に入れる」という意味には読まれていなかった。**
 * **`update` op を撃つ検査は今日も本ファイルに1本も無い** —— **それを測っているのは
 * `create-parent-write.test.ts` の `(j-2)` / `(j-3)` / `(j-4)` である。**
 * **2 / 3 / 4 / 5 は今日も真である**(**`(b-3)` の穴は今日も開いている**)。
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
import { MAX_RECORD_ACCESS_INHERIT_ROWS } from "./owner-scope.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "create-gate";

/** **上限に当たったときだけ出る文**(`errors.ts` の `recordAccessLimitError` の逐語)。 */
const LIMIT_SENTENCE = "引き継ぎの上限を超えているため判定できません";

/**
 * 権限名3つ。**`write` を持つのは `writer` と `keeper` の2つで、`reader` は読むだけである。**
 * **`keeper` は `(f-1)` / `(f-2)` が「書けるが名指しされていない」を作るために要る。**
 */
const PERMISSIONS = [
  { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
  { id: "writer", name: "編集できる", read: true, write: true, delete: false },
  { id: "keeper", name: "任せられる", read: true, write: true, delete: true },
] as const;

/**
 * **段数の鎖の長さ。** **作る先(`lvl0`)の親は `lvl1` であり、その `lvl1` を段0 として
 * 数え直すと `lvl7` が段6 になる** —— **したがって作成の判定は段数の上限に当たる。**
 */
const CHAIN = 8;

/**
 * **辿って読む行の合計を上限の1つ上に置くための、祖父の側の利用者行の数。**
 *
 * **`rc`(作る先)の親は `rp` である。** **判定は `rp` を段0 として辿るので**:
 *  - **段0(`rp`)の付与行・利用者行は1件も数えない。**
 *  - **祖父(`rg`)の行を `readRow` で1件読む** → **+1**。
 *  - **段1(`rg`)の付与行0件 + 利用者行 N 件** → **+N**。
 *
 * **合計 = 1 + N。** **N = 1000 で合計 1001 となり、上限(1000)を超える。**
 */
const ROWS_OVER_LIMIT = MAX_RECORD_ACCESS_INHERIT_ROWS;

/** 親子で同じ形の宣言を持つ(**各段で適用する規則は同一**。`Z-G14` 限定3)。 */
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

/** 段数の鎖の宣言(**付与表・利用者表を本体と分ける** —— 件数の数え方が混ざらないように)。 */
function chainDeclaration(level: number): Record<string, unknown> {
  return {
    enabled: true,
    permissions: [...PERMISSIONS],
    creator_permission: "writer",
    grant: { table: "dep_grant", target: `t${level}`, member: "member", permission: "permission" },
    members: { table: "dep_member", account: "account" },
    ...(level < CHAIN - 1 ? { inherit_from: ["parent"] } : {}),
  };
}

function chainTables(): Record<string, unknown>[] {
  const tables: Record<string, unknown>[] = [];
  for (let level = 0; level < CHAIN; level += 1) {
    tables.push({
      id: `lvl${level}`,
      name: `段${level}`,
      fields: [
        { id: "title", name: "名前", type: "text", required: true },
        ...(level < CHAIN - 1
          ? [{ id: "parent", name: "親", type: "reference", reference_table: `lvl${level + 1}` }]
          : []),
      ],
      access_control: chainDeclaration(level),
    });
  }
  return tables;
}

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "作成の関門",
      // **役割(面)の規則を1本も宣言していない** —— **面が管轄外のままなので、
      // 測っているのは点(行ごとの付与)と、その上に立つ作成の関門だけである。**
      tables: [
        {
          // **親。** **`inherit_from` を持たない。**
          id: "projects",
          name: "プロジェクト",
          fields: [{ id: "title", name: "名前", type: "text", required: true }],
          access_control: declaration("project"),
        },
        {
          // **子。** **親への書込を要求される表である。** **`creatable_by` は書いていない。**
          id: "issues",
          name: "課題",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "project", name: "プロジェクト", type: "reference", reference_table: "projects" },
          ],
          access_control: declaration("issue", { inherit_from: ["project"] }),
        },
        {
          // **子。** **`creatable_by` を宣言している** —— **親に書けるだけでは足りず、
          // 名指しした権限名を親の行に対して持っていなければならない。**
          id: "picked",
          name: "任せられた課題",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "project", name: "プロジェクト", type: "reference", reference_table: "projects" },
          ],
          access_control: declaration("picked", {
            inherit_from: ["project"],
            creatable_by: ["keeper"],
          }),
        },
        {
          // **宣言はあるが `inherit_from` が1本も無い表**(`(b-1)` の対照)。
          id: "solo",
          name: "引き継がない表",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            { id: "project", name: "プロジェクト", type: "reference", reference_table: "projects" },
          ],
          access_control: declaration("solo"),
        },
        {
          // **作った人に権限が1つも渡らない設定の表**(`(g-1)` の材料。`CR-G4` 限定1)。
          // **`creator_permission` が指す `nobody` は3つとも `false` である** ——
          // **この表に行を作ると「作った本人にも見えない行」が生まれる。**
          // **`inherit_from` は1本も無い** —— **測るのは親の関門ではなく、
          // 「作った本人に何も渡らない」を断つ fail-closed のほうである。**
          id: "deadend",
          name: "作った人に何も渡らない表",
          fields: [{ id: "title", name: "件名", type: "text", required: true }],
          access_control: {
            enabled: true,
            permissions: [
              ...PERMISSIONS,
              { id: "nobody", name: "何もできない", read: false, write: false, delete: false },
            ],
            creator_permission: "nobody",
            grant: {
              table: "ac_grant",
              target: "deadend",
              member: "member",
              permission: "permission",
            },
            members: { table: "ac_member", account: "account" },
          },
        },
        {
          // **権限の宣言を1バイトも持たない表**(`(b-2)` の対照)。
          id: "plain",
          name: "宣言していない表",
          fields: [{ id: "title", name: "件名", type: "text", required: true }],
        },
        {
          // **権限の宣言を持たない親**(`(c-1)` の fail-closed の材料)。
          id: "open_projects",
          name: "宣言していないプロジェクト",
          fields: [{ id: "title", name: "名前", type: "text", required: true }],
        },
        {
          // **その親を `inherit_from` で指す子。** **親が宣言していないので誰も作れない。**
          id: "open_issues",
          name: "宣言していない親を持つ課題",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            {
              id: "open_project",
              name: "プロジェクト",
              type: "reference",
              reference_table: "open_projects",
            },
          ],
          access_control: declaration("open_issue", { inherit_from: ["open_project"] }),
        },
        {
          id: "ac_member",
          name: "利用者",
          fields: [{ id: "account", name: "ログイン", type: "text" }],
        },
        {
          id: "ac_grant",
          name: "付与",
          fields: [
            { id: "project", name: "プロジェクト", type: "reference", reference_table: "projects" },
            { id: "issue", name: "課題", type: "reference", reference_table: "issues" },
            { id: "picked", name: "任せられた課題", type: "reference", reference_table: "picked" },
            { id: "solo", name: "引き継がない表", type: "reference", reference_table: "solo" },
            {
              id: "deadend",
              name: "作った人に何も渡らない表",
              type: "reference",
              reference_table: "deadend",
            },
            {
              id: "open_issue",
              name: "宣言していない親を持つ課題",
              type: "reference",
              reference_table: "open_issues",
            },
            { id: "member", name: "相手", type: "reference", reference_table: "ac_member" },
            {
              id: "permission",
              name: "権限",
              type: "select",
              options: ["reader", "writer", "keeper", "nobody"],
            },
          ],
        },
        // --- 段数の上限を測る鎖(`(d-1)` / `(d-3)`)-------------------------------------
        ...chainTables(),
        {
          id: "dep_grant",
          name: "鎖の付与",
          fields: [
            ...Array.from({ length: CHAIN }, (_unused, level) => ({
              id: `t${level}`,
              name: `段${level}`,
              type: "reference",
              reference_table: `lvl${level}`,
            })),
            { id: "member", name: "相手", type: "reference", reference_table: "dep_member" },
            {
              id: "permission",
              name: "権限",
              type: "select",
              options: ["reader", "writer", "keeper"],
            },
          ],
        },
        {
          id: "dep_member",
          name: "鎖の利用者",
          fields: [{ id: "account", name: "ログイン", type: "text" }],
        },
        // --- 行数の上限を測る親子3段(`(d-2)`)------------------------------------------
        {
          id: "rc",
          name: "件数の子",
          fields: [
            { id: "title", name: "名前", type: "text", required: true },
            { id: "parent", name: "親", type: "reference", reference_table: "rp" },
          ],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "writer",
            grant: { table: "row_grant", target: "c", member: "member", permission: "permission" },
            members: { table: "row_member", account: "account" },
            inherit_from: ["parent"],
          },
        },
        {
          id: "rp",
          name: "件数の親",
          fields: [
            { id: "title", name: "名前", type: "text", required: true },
            { id: "parent", name: "祖父", type: "reference", reference_table: "rg" },
          ],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "writer",
            grant: { table: "row_grant", target: "p", member: "member", permission: "permission" },
            members: { table: "row_member", account: "account" },
            inherit_from: ["parent"],
          },
        },
        {
          id: "rg",
          name: "件数の祖父",
          fields: [{ id: "title", name: "名前", type: "text", required: true }],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "writer",
            grant: { table: "row_grant", target: "g", member: "member", permission: "permission" },
            members: { table: "row_member", account: "account" },
          },
        },
        {
          id: "row_grant",
          name: "件数の付与",
          fields: [
            { id: "c", name: "子", type: "reference", reference_table: "rc" },
            { id: "p", name: "親", type: "reference", reference_table: "rp" },
            { id: "g", name: "祖父", type: "reference", reference_table: "rg" },
            { id: "member", name: "相手", type: "reference", reference_table: "row_member" },
            {
              id: "permission",
              name: "権限",
              type: "select",
              options: ["reader", "writer", "keeper"],
            },
          ],
        },
        {
          id: "row_member",
          name: "件数の利用者",
          fields: [{ id: "account", name: "ログイン", type: "text" }],
        },
      ],
      views: [],
    },
  } as unknown as Manifest;
}

/**
 * **【`V8-M26` の既定が閉じているので、`plain` にだけ面の規則を足す】**
 *
 * **`plain` は権限の宣言を1バイトも持たない表である**(`(b-2)` の対照)——
 * **点が管轄外なので、面の規則が1本も無いと表単位の関門
 * (`roleGateBlocksWithoutGrants`)がそこで 403 にする。** **これは本 MS が足す関門とは
 * 別の、今日すでに在る壁である。**
 *
 * **`deadend` にも足す** —— **`(g-1)` は「面が表の書込を許していても、作った本人に何も
 * 渡らない設定なら断る」ことを測るので、面が開いていなければ測れない。**
 *
 * **足すのはその2本だけであり、親の関門を測る表には1本も足さない** ——
 * **足すと `combineRoleAndGrantAccess` の `OR` で面の答えが通り、(a)〜(f) が測っている
 * 「親に書けるか」が丸ごと測れなくなる。**
 */
function manifestWithRoles(): Manifest {
  const base = manifest();
  return withDefaultRoleRules(base, {
    skipTables: base.app.tables
      .map((table) => table.id)
      .filter((id) => id !== "plain" && id !== "deadend"),
    skipAllViews: true,
  });
}

let dataRoot = "";
let app: ReturnType<typeof createServerApp>;

/** 親に `writer` を持つ人 / `reader` しか持たない人 / 付与を1件も持たない人。 */
let writer: ReturnType<typeof seedSession>;
let reader: ReturnType<typeof seedSession>;
let stranger: ReturnType<typeof seedSession>;
/** **持ち主(`owner`)。** **親への付与は1件も持たない。** */
let holder: ReturnType<typeof seedSession>;
/** 親に `keeper` を持つ人(`creatable_by` が名指しした権限名の持ち主)。 */
let keeper: ReturnType<typeof seedSession>;

/** 行の id。 */
let projectId = "";
let openProjectId = "";
let chainRows: string[] = [];
let rowParent = "";

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

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-bcpw-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "作成の関門", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, manifestWithRoles()).valid).toBe(true);
  app = createServerApp({ dataRoot });

  writer = seedSession(dataRoot, APP_ID, { role: "editor", username: "writer" });
  reader = seedSession(dataRoot, APP_ID, { role: "editor", username: "reader" });
  stranger = seedSession(dataRoot, APP_ID, { role: "editor", username: "stranger" });
  holder = seedSession(dataRoot, APP_ID, { role: "owner", username: "holder" });
  keeper = seedSession(dataRoot, APP_ID, { role: "editor", username: "keeper" });

  const loaded = manifest();
  withDb((db) => {
    const id = (result: unknown): string => (result as { value: { _id: string } }).value._id;

    projectId = id(createRecord(db, loaded, "projects", { title: "本命" }));
    openProjectId = id(createRecord(db, loaded, "open_projects", { title: "宣言していない親" }));

    // **5人とも利用者の表に行を持つ**(`outsider` だけが持たない)——
    // **「付与が無い」と「利用者の表に行が無い」を混ぜないためである。**
    const member = (account: string): string =>
      id(createRecord(db, loaded, "ac_member", { account }));
    const writerMember = member(writer.userId);
    const readerMember = member(reader.userId);
    member(stranger.userId);
    member(holder.userId);
    const keeperMember = member(keeper.userId);

    const grant = (values: Record<string, unknown>): void => {
      expect(createRecord(db, loaded, "ac_grant", values).ok).toBe(true);
    };
    grant({ project: projectId, member: writerMember, permission: "writer" });
    grant({ project: projectId, member: readerMember, permission: "reader" });
    grant({ project: projectId, member: keeperMember, permission: "keeper" });

    // --- 段数の鎖(親が先に居ないと参照が張れないので、いちばん上から作る)-------------
    chainRows = [];
    let parent: string | undefined;
    for (let level = CHAIN - 1; level >= 0; level -= 1) {
      const created = id(
        createRecord(db, loaded, `lvl${level}`, {
          title: `段${level}`,
          ...(parent === undefined ? {} : { parent }),
        }),
      );
      chainRows[level] = created;
      parent = created;
    }
    const depMember = id(createRecord(db, loaded, "dep_member", { account: writer.userId }));
    expect(
      createRecord(db, loaded, "dep_grant", {
        [`t${CHAIN - 1}`]: chainRows[CHAIN - 1],
        member: depMember,
        permission: "writer",
      }).ok,
    ).toBe(true);

    // --- 行数の上限(祖父の側の利用者行を上限の1つ上まで並べる)-----------------------
    const grandParent = id(createRecord(db, loaded, "rg", { title: "件数の祖父" }));
    rowParent = id(createRecord(db, loaded, "rp", { title: "件数の親", parent: grandParent }));
    db.transaction(() => {
      for (let index = 0; index < ROWS_OVER_LIMIT; index += 1) {
        createRecord(db, loaded, "row_member", {
          account: index === 0 ? writer.userId : `filler-${index}`,
        });
      }
    })();
  });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

/**
 * **まとめ書きを1回叩く**(**生の応答を返す。報告に貼れる形**)。
 * **単件の {@link create} とヘッダも作法もまったく同じで、URL と本文の形だけが違う。**
 */
async function batch(
  cookie: string,
  ops: readonly unknown[],
): Promise<{ status: number; body: string }> {
  const response = await app.request(`/api/apps/${APP_ID}/batch`, {
    method: "POST",
    headers: { cookie, origin: TEST_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ ops }),
  });
  return { status: response.status, body: await response.text() };
}

/** **作成 op 1件だけのまとめ書き**(単件 `POST` と1対1で並べるための形)。 */
async function batchCreate(
  table: string,
  cookie: string,
  values: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  return batch(cookie, [{ op: "create", table, values }]);
}

/** **その表に今ディスク上にある行の数**(部分適用がゼロであることを直に見る)。 */
function countRows(table: string): number {
  return withDb((db) => (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}

/**
 * **応答コードを「成功 / 断りのコード」に畳む**(`(q-1)` 専用)。
 *
 * **【正直に書く。単件とまとめ書きは、成功のときのコードがそもそも違う】** ——
 * **単件 `POST` は `201`、まとめ書きは `200` を返す**(着手前からそうであり、本 MS は
 * それを1バイトも変えない)。**したがって `(q-1)` が突き合わせるのは「同じ題材で
 * 同じ**判定**に行き着くか」であって、数字そのものの一致ではない。**
 * **断り(4xx)のコードは畳まずにそのまま比べる** —— **そこがずれることが、
 * `CR-G5` が塞ぐ食い違いそのものだからである。**
 */
function verdictOf(out: { status: number }): string {
  return out.status === 200 || out.status === 201 ? "ok" : String(out.status);
}

// ---------------------------------------------------------------------------
// (a) 親への書込を要求する(`CR-G5` = 単件と同じ判定をまとめ書きにも)
// ---------------------------------------------------------------------------

describe("V15-M3 (a): まとめ書きでも、親に書けるかどうかで作れるかが決まる", () => {
  test("(a-1) 親に `write` を持つ人の作成 op は通る(200)【陰性対照】", async () => {
    const out = await batchCreate("issues", writer.cookie, { title: "作る", project: projectId });
    expect(out).toEqual({ status: 200, body: out.body });
    expect(out.status).toBe(200);
  });

  test("(a-2) 親に `read` しか持たない人の作成 op は 403", async () => {
    const out = await batchCreate("issues", reader.cookie, { title: "作る", project: projectId });
    expect(out.status).toBe(403);
  });

  test("(a-3) 親に付与を1件も持たない人の作成 op は 403", async () => {
    const out = await batchCreate("issues", stranger.cookie, { title: "作る", project: projectId });
    expect(out.status).toBe(403);
  });

  test("(a-4) 持ち主(owner)でも、親に `write` が無ければ 403", async () => {
    // **運営ロールは前提の関門を迂回しない** —— **まとめ書きでも単件と同じである。**
    const out = await batchCreate("issues", holder.cookie, { title: "作る", project: projectId });
    expect(out.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// (b) 掛からないところは、まとめ書きでも今日と1ミリも変わらない
// ---------------------------------------------------------------------------

describe("V15-M3 (b): この段が掛からないところは、まとめ書きでも今日と変わらない", () => {
  test("(b-1) `inherit_from` を1本も宣言していない表への作成 op は通る【陰性対照】", async () => {
    const out = await batchCreate("solo", stranger.cookie, { title: "作る", project: projectId });
    expect(out.status).toBe(200);
  });

  test("(b-2) 権限の宣言を持たない表への作成 op は通る【陰性対照】", async () => {
    const out = await batchCreate("plain", stranger.cookie, { title: "作る" });
    expect(out.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// (c) fail-closed —— **親の表が権限を宣言していなければ、まとめ書きでも誰も作れない**
// ---------------------------------------------------------------------------

describe("V15-M3 (c): 宣言していない親を持つ表には、まとめ書きでも行を作れない", () => {
  test("(c-1) 親の表が権限を宣言していなければ 403", async () => {
    // **【代金を隠さない】** —— **単件と同じく、持ち主(`owner`)も止まる。**
    const asStranger = await batchCreate("open_issues", stranger.cookie, {
      title: "作る",
      open_project: openProjectId,
    });
    const asHolder = await batchCreate("open_issues", holder.cookie, {
      title: "作る",
      open_project: openProjectId,
    });
    expect({ stranger: asStranger.status, holder: asHolder.status }).toEqual({
      stranger: 403,
      holder: 403,
    });
  });
});

// ---------------------------------------------------------------------------
// (d) 3状態 —— **まとめ書きでも「作れない」と2種の上限が区別できる**(`CR-G6`)
// ---------------------------------------------------------------------------

describe("V15-M3 (d): まとめ書きでも断りの3状態が応答の上で区別できる", () => {
  test("(d-1) 段数の上限に当たったら 400 + 上限の文面(段数)", async () => {
    const out = await batchCreate("lvl0", writer.cookie, {
      title: "作る",
      parent: chainRows[1] as string,
    });
    expect(out.status).toBe(400);
    const body = JSON.parse(out.body) as { errors: { message: string; hint: string }[] };
    expect(body.errors[0]?.message).toContain(LIMIT_SENTENCE);
    expect(body.errors[0]?.message).toContain("段数");
    expect(body.errors[0]?.hint).toContain("段数");
  });

  test("(d-2) 行数の上限に当たったら 400 + 上限の文面(件数)", async () => {
    const out = await batchCreate("rc", writer.cookie, { title: "作る", parent: rowParent });
    expect(out.status).toBe(400);
    const body = JSON.parse(out.body) as { errors: { message: string; hint: string }[] };
    expect(body.errors[0]?.message).toContain(LIMIT_SENTENCE);
    expect(body.errors[0]?.message).toContain("件数");
  });
});

// ---------------------------------------------------------------------------
// (e) 文面の作法(`ADR-0404` 限定9)—— **新しい断り文を1つも作らない**
// ---------------------------------------------------------------------------

describe("V15-M3 (e): まとめ書きの断り文も作法を1つも破っていない", () => {
  test("(e-1) 断り文に内部記号が1文字も無い", async () => {
    const out = await batchCreate("issues", reader.cookie, { title: "作る", project: projectId });
    expect(out.status).toBe(403);
    for (const symbol of [
      "access_control",
      "creatable_by",
      "inherit_from",
      "creator_permission",
      "projects",
      "issues",
      "CR-G",
      "Z-G",
    ]) {
      expect({ symbol, leaked: out.body.includes(symbol) }).toEqual({ symbol, leaked: false });
    }
  });
});

// ---------------------------------------------------------------------------
// (p) 部分適用ゼロ —— **1つでも止まったら、1行も書かれない**(`ADR-0039` の原子性)
// ---------------------------------------------------------------------------

describe("V15-M3 (p): 1件でも親に書けない op があれば、要求全体が1行も書かない", () => {
  test("(p-1) 通る op と親に書けない op を混ぜると、通る側の行も1件も書かれない", async () => {
    // **`solo` は `inherit_from` を1本も持たないので、単独なら `reader` でも作れる**
    // (`(b-1)` と同じ表)。**同じ要求に「親に書けない op」を1件混ぜると、
    // その `solo` の行も1件も書かれない。**
    const before = { solo: countRows("solo"), issues: countRows("issues") };
    const out = await batch(reader.cookie, [
      { op: "create", table: "solo", values: { title: "通る側", project: projectId } },
      { op: "create", table: "issues", values: { title: "止まる側", project: projectId } },
    ]);
    expect({
      status: out.status,
      solo: countRows("solo"),
      issues: countRows("issues"),
    }).toEqual({ status: 403, solo: before.solo, issues: before.issues });
  });

  test("(p-2) 同じ要求の中で作った親は、判定からは見えない(403 で1行も書かれない)", async () => {
    // **【葉タスクの想定が実物と食い違った点。丸めない】** —— **`_id` はカーネルが管理する
    // システム列なので `values` に書けない**(実測: `400` + 「システム列なので書き込めません」)。
    // **したがって「同じ要求の中で作った親」を字義どおり名指しする手が1つも無い。**
    // **ここでは、親を作る op と、**まだディスクに無い id** を指す子の op を並べている** ——
    // **判定はすべて `writeRecords` の tx を**開く前**に行われるので、同じ要求の中で作る
    // つもりの親は判定からは見えず、子の op は 403 になる。**
    const before = countRows("projects");
    const out = await batch(writer.cookie, [
      { op: "create", table: "projects", values: { title: "同じ要求で作る親" } },
      {
        op: "create",
        table: "issues",
        values: { title: "その親を指す子", project: "not-yet-on-disk" },
      },
    ]);
    expect({ status: out.status, projects: countRows("projects") }).toEqual({
      status: 403,
      projects: before,
    });
  });
});

// ---------------------------------------------------------------------------
// (q) 入口の一致(`V8-M19` / `D-V8-23` の逐語「入口を何本生やしても振る舞いが一致する」)
// ---------------------------------------------------------------------------

describe("V15-M3 (q): 同じ題材なら、単件 `POST` とまとめ書きが同じ答えに行き着く", () => {
  test("(q-1) 6つの題材で、単件とまとめ書きの判定が1件もずれない", async () => {
    // **`deadend` の行が要である** —— **`V15-M2` が単件側で fail-closed
    // (「作った本人に何も渡らない設定」)を合成(`OR`)の**前**へ出したので、
    // 着手前のまとめ書き側(`OR` の中に畳まれたまま)とは答えがずれていた。**
    // **面の規則が表の書込を許しているので、まとめ書きでは今日 `OR` が通してしまう。**
    const materials: {
      name: string;
      table: string;
      cookie: () => string;
      values: () => Record<string, unknown>;
    }[] = [
      {
        name: "親に read しか無い人",
        table: "issues",
        cookie: () => reader.cookie,
        values: () => ({ title: "作る", project: projectId }),
      },
      {
        name: "親に write を持つ人",
        table: "issues",
        cookie: () => writer.cookie,
        values: () => ({ title: "作る", project: projectId }),
      },
      {
        name: "親の表が宣言していない",
        table: "open_issues",
        cookie: () => stranger.cookie,
        values: () => ({ title: "作る", open_project: openProjectId }),
      },
      {
        name: "段数の上限に当たる鎖",
        table: "lvl0",
        cookie: () => writer.cookie,
        values: () => ({ title: "作る", parent: chainRows[1] as string }),
      },
      {
        name: "作った本人に何も渡らない表",
        table: "deadend",
        cookie: () => writer.cookie,
        values: () => ({ title: "作る" }),
      },
      {
        name: "権限の宣言を持たない表",
        table: "plain",
        cookie: () => stranger.cookie,
        values: () => ({ title: "作る" }),
      },
    ];
    const measured: { name: string; single: string; batch: string }[] = [];
    for (const material of materials) {
      const single = await create(material.table, material.cookie(), material.values());
      const many = await batchCreate(material.table, material.cookie(), material.values());
      measured.push({ name: material.name, single: verdictOf(single), batch: verdictOf(many) });
    }
    expect(measured).toEqual([
      { name: "親に read しか無い人", single: "403", batch: "403" },
      { name: "親に write を持つ人", single: "ok", batch: "ok" },
      { name: "親の表が宣言していない", single: "403", batch: "403" },
      { name: "段数の上限に当たる鎖", single: "400", batch: "400" },
      { name: "作った本人に何も渡らない表", single: "400", batch: "400" },
      { name: "権限の宣言を持たない表", single: "ok", batch: "ok" },
    ]);
  });
});
