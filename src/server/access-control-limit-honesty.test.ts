/**
 * **`V7-M4-T04` / `Z-G17`**: **段数と件数の上限に当たったことを、黙らずに出す。**
 *
 * ## 何を測るか(起票の完了条件の逐語)
 *
 * > **内容**: **段数5段**(`D-V7-16`)+ **読む行の合計 1000 行**で打ち切り、**明示して
 * > 拒否**する。**上限は `schemas/` に書かず `src/server/` の定数に置く。**
 * > **完了条件**: (i) 6段目で「引き継ぎの上限を超えているため判定できません」が**画面にも
 * > エラー本文にも出る**。(ii) 1001 行目で同じ形で拒否される。(iii) **上限に当たった状態と
 * > 「本当に見えない」状態が応答の上で区別できる**(前者は 4xx + 上限の種別、後者は 404 か
 * > 一覧から落ちるだけ)。(iv) `git diff --numstat <sha>..HEAD -- schemas/` に上限の数値が
 * > 1つも現れない。
 *
 * **`v7-m0.md` §6-4b の3(応答は3状態)の逐語**:
 * > **(a) 上限に当たった(4xx + 上限の種別)/ (b) 循環した(正常完了。訪問済みを2度
 * > 辿らないだけ)/ (c) 本当に見えない(404 か一覧から落ちるだけ)。**
 *
 * ## **【この上限を置く理由。禁止事項を先に書く】**
 *
 * **【禁止】この上限を「性能上の都合」と書かない**(`v7-m0.md` §5-5 (b))。
 * **置く理由は、黙った打ち切りが「隠れた行がある」と区別できないからである。**
 * **上限の値 5 / 1000 に実測の根拠は1件も無い。**
 *
 * ## (A)〜(F) の対応(発注書の完了条件 (A) の1〜5)
 *
 *  - **(A) 6段目で拒否される**(API の生の応答: ステータス + 本文)。
 *  - **(B) 5段までは今日どおり届く**(**拒否側だけを測ると、全部拒否しても緑になる**)。
 *  - **(C) 1001 行目で拒否される / 1000 行までは通る**(API + 純関数の両方で境界を測る)。
 *  - **(D) 3状態が応答の上で区別できる**(**1つのテストの中で3つを並べて突き合わせる**)。
 *  - **(E) 8経路の状態**(打ち切りが 4xx になっているか / 丸められていないか)。
 *  - **(F) 上限の値の置き場所**(`src/server/` の定数であり、`schemas/` に無い)。
 *
 * ## **【誇張しない。本ファイルが測っていないこと・今日の限界】**
 *
 *  1. **`POST`(作成)では、この上限に当たりようが無い** —— **作成の下見は
 *     `judgeRecordAccess` を直接呼び、親を1段も辿らないからである。**
 *     **8経路のうち打ち切りが出うるのは7本であり、`POST` は「4xx になる」ではなく
 *     「上限に当たりうる判定を1つも行っていない」である。** **これを (E) で名指しする。**
 *  2. **環の長さが5段を超えるときは、段数の上限が先に当たる** —— **したがって
 *     「循環は必ず正常完了する」とは書けない。** (D) が測るのは**長さ2の環**である。
 *  3. **件数の数え方は段0 を数えない**(下の `ROWS_AT_LIMIT` の doc)。**したがって
 *     「1回の要求で読む行が 1000 行を超えない」とは書けない** —— **1リクエストで実際に
 *     読む行数には今日も歯止めが無い。**
 *  4. **アプリを作る人は、上限の値をマニフェストから1つも読めない**(上限は
 *     `src/server/` の定数であって語彙ではない)。**要件ドキュメントにも出ない。**
 *  5. **性能を1件も測っていない。**
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
import {
  MAX_RECORD_ACCESS_INHERIT_DEPTH,
  MAX_RECORD_ACCESS_INHERIT_ROWS,
  resolveRecordAccess,
} from "./owner-scope.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

/**
 * 移した公開単位の根(`apps/smailtalk/`)。**`import.meta.dir` から数える** ——
 * cwd 相対で解くと `bun test` を打つ場所で結果が変わる(`src/` はもうルート直下に無い)。
 */
const PRODUCT_ROOT = join(import.meta.dir, "..", "..");

const APP_ID = "limit-honesty";

/** 上限に当たったときの文面の核(**利用者の言葉**)。 */
const LIMIT_SENTENCE = "引き継ぎの上限を超えているため判定できません";

const PERMISSIONS = [
  { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
  { id: "writer", name: "編集できる", read: true, write: true, delete: false },
  { id: "keeper", name: "作った人", read: true, write: true, delete: true },
] as const;

/**
 * **段数を測る鎖の長さ。** **`lvl0` → `lvl1` → … → `lvl6` の7段を作る。**
 *
 * - **`lvl0` の行を判定すると、段5(`lvl5`)まで辿ったあと段6(`lvl6`)へ進もうとして
 *   上限に当たる** —— **(A) が測る。**
 * - **`lvl1` の行を判定すると、段5(`lvl6`)で鎖が終わるので**今日どおり判定が届く** ——
 *   **(B) が測る。** **`lvl6` に付けた付与1件だけで `lvl1` の行が見える。**
 */
const CHAIN = 7;

/**
 * **`row_member` の行数を、辿って読む行の合計がちょうど上限になるところに置く。**
 *
 * **数え方(実装の doc と同じ逐語)**: **1回の判定ごとに、(a) `readRow` で読んだ親の行と、
 * (b) 親の段で `readRows` から取り出した付与行・メンバー行・グループ行の件数を数える。**
 * **キャッシュに当たったかどうかに関係なく、その判定が参照した行数として数える。**
 * **段0(対象の表)の付与行・メンバー行は数えない。**
 *
 * **`rowc` の行1件の判定でこうなる**:
 *  - **段0(`rowc`)**: 付与1件 + メンバー N 件を読むが、**1件も数えない**。
 *  - **親を1行読む**(`readRow(rowp, …)`)→ **+1**。
 *  - **段1(`rowp`)**: 付与1件 + メンバー N 件 → **+(1 + N)**。
 *
 * **合計 = 2 + N。** **N = 998 で合計 1000(通る)、N = 999 で合計 1001(拒否)。**
 */
const ROWS_AT_LIMIT = MAX_RECORD_ACCESS_INHERIT_ROWS - 2; // = 998

/** 段数の鎖の宣言(**各段で適用する規則は同一**。`Z-G14` 限定3)。 */
function chainDeclaration(level: number): Record<string, unknown> {
  return {
    enabled: true,
    permissions: [...PERMISSIONS],
    creator_permission: "keeper",
    grant: {
      table: "dep_grant",
      target: `t${level}`,
      member: "member",
      permission: "permission",
    },
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
        { id: "state", name: "状態", type: "text" },
        ...(level === 0 ? [{ id: "cover", name: "画像", type: "image" }] : []),
        ...(level < CHAIN - 1
          ? [
              {
                id: "parent",
                name: "親",
                type: "reference",
                reference_table: `lvl${level + 1}`,
              },
            ]
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
      name: "上限の正直さ",
      tables: [
        ...chainTables(),
        {
          // **段数の鎖の付与表**(7段が同じ表を名指しし、対象の列だけが違う)。
          id: "dep_grant",
          name: "鎖の付与",
          fields: [
            ...Array.from({ length: CHAIN }, (_unused, level) => ({
              id: `t${level}`,
              name: `段${level}`,
              type: "reference",
              reference_table: `lvl${level}`,
            })),
            {
              id: "plain_target",
              name: "引き継がない表",
              type: "reference",
              reference_table: "plain",
            },
            {
              id: "owned_target",
              name: "個人所有の子",
              type: "reference",
              reference_table: "owned",
            },
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
        {
          // **件数を測る親子(1段だけ)。** **付与表・利用者表を鎖とは分ける** ——
          // **同じ表を使うと、段数の鎖の判定まで件数の影響を受けるからである。**
          id: "rowc",
          name: "件数の子",
          fields: [
            { id: "title", name: "名前", type: "text", required: true },
            { id: "parent", name: "親", type: "reference", reference_table: "rowp" },
          ],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "keeper",
            grant: { table: "row_grant", target: "c", member: "member", permission: "permission" },
            members: { table: "row_member", account: "account" },
            inherit_from: ["parent"],
          },
        },
        {
          id: "rowp",
          name: "件数の親",
          fields: [{ id: "title", name: "名前", type: "text", required: true }],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "keeper",
            grant: { table: "row_grant", target: "p", member: "member", permission: "permission" },
            members: { table: "row_member", account: "account" },
          },
        },
        {
          id: "row_grant",
          name: "件数の付与",
          fields: [
            { id: "c", name: "子", type: "reference", reference_table: "rowc" },
            { id: "p", name: "親", type: "reference", reference_table: "rowp" },
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
        {
          // **(c)「本当に見えない」の対照。** **引き継ぎを1本も持たない宣言つきの表で、
          // 付与を1件も持たない人から見る。**
          id: "plain",
          name: "引き継がない表",
          fields: [{ id: "title", name: "名前", type: "text", required: true }],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "keeper",
            grant: {
              table: "dep_grant",
              target: "plain_target",
              member: "member",
              permission: "permission",
            },
            members: { table: "dep_member", account: "account" },
          },
        },
        {
          // **(b)「循環した」の対照。** **長さ2の環**(`cyc_a` ⇄ `cyc_b`)。
          id: "cyc_a",
          name: "環A",
          fields: [
            { id: "title", name: "名前", type: "text", required: true },
            { id: "other", name: "相方", type: "reference", reference_table: "cyc_b" },
          ],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "keeper",
            grant: { table: "cyc_grant", target: "a", member: "member", permission: "permission" },
            members: { table: "dep_member", account: "account" },
            inherit_from: ["other"],
          },
        },
        {
          id: "cyc_b",
          name: "環B",
          fields: [
            { id: "title", name: "名前", type: "text", required: true },
            { id: "other", name: "相方", type: "reference", reference_table: "cyc_a" },
          ],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "keeper",
            grant: { table: "cyc_grant", target: "b", member: "member", permission: "permission" },
            members: { table: "dep_member", account: "account" },
            inherit_from: ["other"],
          },
        },
        {
          id: "cyc_grant",
          name: "環の付与",
          fields: [
            { id: "a", name: "環A", type: "reference", reference_table: "cyc_a" },
            { id: "b", name: "環B", type: "reference", reference_table: "cyc_b" },
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
          // **一覧 GET の**もう1本の分岐**(`st_owner` と宣言が同居する表)。**
          // **親は `lvl1` なので、段1〜段5 を辿ったあと段6 で上限に当たる。**
          id: "owned",
          name: "個人所有の子",
          fields: [
            { id: "title", name: "名前", type: "text", required: true },
            { id: "st_owner", name: "所有者", type: "text" },
            { id: "parent", name: "親", type: "reference", reference_table: "lvl1" },
          ],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "keeper",
            grant: {
              table: "dep_grant",
              target: "owned_target",
              member: "member",
              permission: "permission",
            },
            members: { table: "dep_member", account: "account" },
            inherit_from: ["parent"],
          },
        },
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
          id: "lvl0-list",
          type: "list_view",
          table: "lvl0",
          columns: ["title", "state"],
          actions: [{ run: "stamp", name: "印をつける" }],
        },
      ],
      workflows: [
        {
          id: "stamp",
          name: "印をつける",
          trigger: { type: "manual", table: "lvl0" },
          actions: [
            {
              action: "update_record",
              table: "lvl0",
              target: "$record._id",
              values: { state: "済" },
            },
          ],
          history_table: "wf_runs",
        },
      ],
    },
  } as unknown as Manifest;
}

/**
 * **【`V8-M26`】面(役割に束ねた権限)の既定が「閉じる」側へ倒れたので、題材へ規則を足す。**
 *
 * **足すのは画面 `lvl0-list` の読取1本だけである** —— **`skipTables` に**全表**を挙げた。**
 *
 * **表を1つも開けない理由**: **本ファイルが `HTTP` から触る表は
 * `lvl0` / `lvl1` / `rowc` / `cyc_a` / `plain` / `owned` の6つで、**どれも
 * `access_control` を宣言した保護対象の表**である。** **面の規則を1本でも足すと
 * `combineRoleAndGrantAccess` の `OR` で面の答えが通り、(A)〜(E) が測っている
 * 「引き継ぎを辿った結果」が丸ごと測れなくなる。** **付与表・利用者表・`wf_runs` も
 * `HTTP` から1度も触らない**(行はカーネル経路の `createRecord` で作る)ので開ける必要が無い。
 *
 * **画面を1本だけ開ける理由**: **(E-1) の経路6(画面の操作起点)は、レコードの経路と違って
 * 行ごとの付与(点)の管轄内ではないので、面が閉じたままだと引き継ぎの上限に到達する前に
 * `403`(`画面 "lvl0-list"` の閲覧)で止まる。** **経路6 が測っているのは
 * 「打ち切りが 400 + 上限の文面で出る」ことなので、画面の壁は開けたうえで測る。**
 * **実アプリでは `apply-diff.ts` の自動付与が `add_view` のたびに同じ規則を入れる。**
 *
 * **ボタンの規則は1本も入らない** —— **`lvl0-list` の操作起点は `id` を持たない
 * (`{ run: "stamp", name: "印をつける" }`)ので、面から名指しできず今日も管轄外である**
 * (`app.ts` の逐語「識別子(`view_action.id`)を書いていない操作起点は面から名指しできない
 * ので、ここでは管轄外(全許可)になる」)。
 */
function manifestWithRoles(): Manifest {
  const base = manifest();
  return withDefaultRoleRules(base, {
    skipTables: base.app.tables.map((table) => table.id),
  });
}

let dataRoot = "";
let app: ReturnType<typeof createServerApp>;

/** 鎖の頂点(`lvl6`)に付与を持つ人。**`lvl0` にも `lvl1` にも直接の付与は無い。** */
let deep: ReturnType<typeof seedSession>;

/** 行の id。 */
const chainRows: string[] = [];
let plainRow = "";
let cycARow = "";
let rowChild = "";
let ownedRow = "";
let coverFile = "";

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

async function send(
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  cookie: string,
  body: unknown,
  extra: Record<string, string> = {},
): Promise<Response> {
  return await app.request(path, {
    method,
    headers: { cookie, origin: TEST_ORIGIN, "content-type": "application/json", ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function versionOf(table: string, recordId: string): string {
  return withDb(
    (db) =>
      (
        db.query(`SELECT _updated_at FROM ${table} WHERE _id = ?`).get(recordId) as {
          _updated_at: string;
        }
      )._updated_at,
  );
}

/** **応答の生出力**(報告に貼れる形)。 */
async function raw(response: Response): Promise<{ status: number; body: string }> {
  return { status: response.status, body: await response.text() };
}

async function upload(cookie: string): Promise<string> {
  const form = new FormData();
  form.set(
    "file",
    new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])]),
    "cover.png",
  );
  const response = await app.request(
    new Request(`http://localhost/api/apps/${APP_ID}/files`, {
      method: "POST",
      headers: { cookie, origin: TEST_ORIGIN },
      body: form,
    }),
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { file_id: string }).file_id;
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-aclh-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "上限の正直さ", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, manifestWithRoles()).valid).toBe(true);
  app = createServerApp({ dataRoot });

  deep = seedSession(dataRoot, APP_ID, { role: "editor", username: "deep" });
  coverFile = await upload(deep.cookie);

  const loaded = manifest();
  withDb((db) => {
    const id = (result: unknown): string => (result as { value: { _id: string } }).value._id;

    // --- 段数の鎖(`lvl6` から下へ作る。親が先に居ないと参照が張れない)-----------------
    chainRows.length = 0;
    let parent: string | undefined;
    for (let level = CHAIN - 1; level >= 0; level -= 1) {
      const created = id(
        createRecord(db, loaded, `lvl${level}`, {
          title: `段${level}`,
          ...(parent === undefined ? {} : { parent }),
          ...(level === 0 ? { cover: coverFile } : {}),
        }),
      );
      chainRows[level] = created;
      parent = created;
    }

    // --- 利用者と、頂点(`lvl6`)への付与1件 -------------------------------------------
    const deepMember = id(createRecord(db, loaded, "dep_member", { account: deep.userId }));
    expect(
      createRecord(db, loaded, "dep_grant", {
        t6: chainRows[CHAIN - 1],
        member: deepMember,
        permission: "keeper",
      }).ok,
    ).toBe(true);

    // --- (c) 本当に見えない行(付与を1件も持たない)------------------------------------
    plainRow = id(createRecord(db, loaded, "plain", { title: "見えない" }));

    // --- (b) 長さ2の環。**環の中(B)に付与を1件置く** ---------------------------------
    cycARow = id(createRecord(db, loaded, "cyc_a", { title: "A" }));
    const cycBRow = id(createRecord(db, loaded, "cyc_b", { title: "B", other: cycARow }));
    db.query("UPDATE cyc_a SET other = ? WHERE _id = ?").run(cycBRow, cycARow);
    expect(
      createRecord(db, loaded, "cyc_grant", {
        b: cycBRow,
        member: deepMember,
        permission: "keeper",
      }).ok,
    ).toBe(true);

    // --- 一覧 GET のもう1本の分岐(`st_owner` と宣言の同居)------------------------------
    ownedRow = id(
      createRecord(db, loaded, "owned", {
        title: "自分の行",
        st_owner: deep.userId,
        parent: chainRows[1],
      }),
    );

    // --- 件数の親子。**メンバー行を `ROWS_AT_LIMIT` 件そろえる** -------------------------
    const parentRow = id(createRecord(db, loaded, "rowp", { title: "件数の親" }));
    rowChild = id(createRecord(db, loaded, "rowc", { title: "件数の子", parent: parentRow }));
    const rowMember = id(createRecord(db, loaded, "row_member", { account: deep.userId }));
    expect(
      createRecord(db, loaded, "row_grant", {
        p: parentRow,
        member: rowMember,
        permission: "keeper",
      }).ok,
    ).toBe(true);
    // **残りの利用者行を一括で入れる**(1件ずつだと遅いのでトランザクションで束ねる)。
    db.transaction(() => {
      for (let index = 1; index < ROWS_AT_LIMIT; index += 1) {
        createRecord(db, loaded, "row_member", { account: `filler-${index}` });
      }
    })();
  });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

/** **件数の判定を1件増やす**(= 合計を 1000 → 1001 にする)。 */
function addOneMoreMemberRow(): void {
  withDb((db) => {
    expect(createRecord(db, manifest(), "row_member", { account: "one-more" }).ok).toBe(true);
  });
}

// ---------------------------------------------------------------------------
// (A) 6段目で拒否される —— **API の生の応答(ステータス + 本文)**
// ---------------------------------------------------------------------------

describe("V7-M4-T04 (A): 6段目に進もうとしたら、明示して拒否される", () => {
  test("(A-1) 単件 GET(`lvl0`)は 400 で、本文に「引き継ぎの上限を超えているため判定できません」と段数が出る", async () => {
    const response = await get(
      `/api/apps/${APP_ID}/tables/lvl0/records/${chainRows[0]}`,
      deep.cookie,
    );
    const out = await raw(response);
    // **生の応答**(報告に貼る)。
    expect(out.status).toBe(400);
    const body = JSON.parse(out.body) as { errors: { message: string; hint: string }[] };
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]?.message).toContain(LIMIT_SENTENCE);
    // **上限の種別(段数)が本文から読み取れる。**
    expect(body.errors[0]?.message).toContain("段数");
    expect(body.errors[0]?.hint).toContain("段数");
  });

  test("(A-2) 文面に内部の記号が1つも出ない(利用者の言葉である)", async () => {
    const response = await get(
      `/api/apps/${APP_ID}/tables/lvl0/records/${chainRows[0]}`,
      deep.cookie,
    );
    const text = await response.text();
    for (const symbol of [
      "Z-G17",
      "inherit_from",
      "resolveRecordAccess",
      "limit_exceeded",
      "access_control",
      "MAX_RECORD_ACCESS",
      "depth",
      "rows",
    ]) {
      expect({ symbol, appears: text.includes(symbol) }).toEqual({ symbol, appears: false });
    }
  });

  test("(A-3) 一覧 GET(`lvl0`)も要求全体が 400 になる(黙って行を落とさない)", async () => {
    const response = await get(`/api/apps/${APP_ID}/tables/lvl0/records`, deep.cookie);
    const out = await raw(response);
    expect(out.status).toBe(400);
    expect(out.body).toContain(LIMIT_SENTENCE);
    // **`records` を持たない** = **「0件の一覧」に丸めていない。**
    expect(JSON.parse(out.body)).not.toHaveProperty("records");
  });
});

// ---------------------------------------------------------------------------
// (B) 5段までは今日どおり届く —— **拒否側だけを測ると、全部拒否しても緑になる**
// ---------------------------------------------------------------------------

describe("V7-M4-T04 (B): 段5 までは今日どおり判定が届く", () => {
  test("(B-1) `lvl1` の行は 200 で読める(頂点 `lvl6` の付与1件が5段先まで届く)", async () => {
    const response = await get(
      `/api/apps/${APP_ID}/tables/lvl1/records/${chainRows[1]}`,
      deep.cookie,
    );
    const out = await raw(response);
    expect(out.status).toBe(200);
    expect(out.body).not.toContain(LIMIT_SENTENCE);
  });

  test("(B-2) `lvl1` の一覧 GET も 200 で、その行が1件返る", async () => {
    const response = await get(`/api/apps/${APP_ID}/tables/lvl1/records`, deep.cookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { records: { _id: string }[] };
    expect(body.records.map((row) => row._id)).toEqual([chainRows[1] as string]);
  });

  test("(B-3) 段数の境界は `MAX_RECORD_ACCESS_INHERIT_DEPTH` ちょうどである(定数を動かせば結果が動く)", () => {
    expect(MAX_RECORD_ACCESS_INHERIT_DEPTH).toBe(5);
    // **段0 から数えて、辿れる親の段は 1..5 の5段である。**
    // **`lvl1` は 5段先(`lvl6`)で鎖が終わり、`lvl0` は 6段先へ進もうとして止まる。**
    expect(CHAIN - 1 - 1).toBe(MAX_RECORD_ACCESS_INHERIT_DEPTH);
  });

  test("(B-4) 純関数でも、ちょうど5段は通り6段目で拒否される", () => {
    const rows = Array.from({ length: CHAIN }, (_unused, level) => ({
      _id: `r${level}`,
      ...(level < CHAIN - 1 ? { parent: `r${level + 1}` } : {}),
    }));
    const readRow = (tableId: string, recordId: string): Record<string, unknown> | undefined =>
      rows.find((row) => row._id === recordId && `lvl${rows.indexOf(row)}` === tableId);
    const call = (level: number) =>
      resolveRecordAccess({
        manifest: manifest(),
        tableId: `lvl${level}`,
        row: rows[level] as Record<string, unknown>,
        actorId: "nobody",
        readRows: () => [],
        readRow,
      });
    expect(call(1).kind).toBe("verdict"); // 段1 → 段5(`lvl6`)で鎖が終わる
    expect(call(0)).toEqual({ kind: "limit_exceeded", limit: "depth" });
  });
});

// ---------------------------------------------------------------------------
// (C) 1001 行目で拒否される / 1000 行までは通る
// ---------------------------------------------------------------------------

describe("V7-M4-T04 (C): 辿って読む行の合計 1000 が境界である", () => {
  test("(C-1) 合計ちょうど 1000 行なら通る(200)", async () => {
    const response = await get(`/api/apps/${APP_ID}/tables/rowc/records/${rowChild}`, deep.cookie);
    const out = await raw(response);
    expect(out.status).toBe(200);
    expect(out.body).not.toContain(LIMIT_SENTENCE);
  });

  test("(C-2) 1行足して 1001 行になった瞬間に、同じ要求が 400 になる", async () => {
    addOneMoreMemberRow();
    const response = await get(`/api/apps/${APP_ID}/tables/rowc/records/${rowChild}`, deep.cookie);
    const out = await raw(response);
    expect(out.status).toBe(400);
    const body = JSON.parse(out.body) as { errors: { message: string; hint: string }[] };
    expect(body.errors[0]?.message).toContain(LIMIT_SENTENCE);
    // **上限の種別(件数)が本文から読み取れる** —— **段数の文面と取り違えない。**
    expect(body.errors[0]?.message).toContain("件数");
    expect(body.errors[0]?.message).not.toContain("段数");
  });

  test("(C-3) 一覧 GET も、1001 行目で要求全体が 400 になる", async () => {
    const before = await get(`/api/apps/${APP_ID}/tables/rowc/records`, deep.cookie);
    expect(before.status).toBe(200);
    addOneMoreMemberRow();
    const after = await raw(await get(`/api/apps/${APP_ID}/tables/rowc/records`, deep.cookie));
    expect(after.status).toBe(400);
    expect(after.body).toContain(LIMIT_SENTENCE);
  });

  test("(C-4) 純関数でも境界は 1000 / 1001 ちょうどである(段0 は数えない)", () => {
    const child = { _id: "c-1", parent: "p-1" };
    const parentRow = { _id: "p-1" };
    /** **段0 でも親の段でも同じ件数を返す** —— **段0 が数えられていないことも同時に測る。** */
    const call = (memberCount: number) =>
      resolveRecordAccess({
        manifest: manifest(),
        tableId: "rowc",
        row: child,
        actorId: "nobody",
        readRows: (tableId) =>
          tableId === "row_member"
            ? Array.from({ length: memberCount }, (_unused, index) => ({
                _id: `m-${index}`,
                account: `filler-${index}`,
              }))
            : [{ _id: "g-1", p: "p-1", member: "m-0", permission: "keeper" }],
        readRow: (tableId, recordId) =>
          tableId === "rowp" && recordId === "p-1" ? parentRow : undefined,
      });
    // **合計 = 1(親の行)+ 1(親の段の付与)+ N(親の段のメンバー)。**
    expect(call(ROWS_AT_LIMIT).kind).toBe("verdict"); // 2 + 998 = 1000
    expect(call(ROWS_AT_LIMIT + 1)).toEqual({ kind: "limit_exceeded", limit: "rows" }); // 1001
    expect(MAX_RECORD_ACCESS_INHERIT_ROWS).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// (D) 3状態が応答の上で区別できる —— **3つを1つのテストの中で並べて突き合わせる**
// ---------------------------------------------------------------------------

describe("V7-M4-T04 (D): (a) 上限 / (b) 循環 / (c) 本当に見えない を応答の形で区別する", () => {
  test("(D-1) 単件 GET の3組を並べる —— 400+種別 / 200 / 404(上限の文面を持たない)", async () => {
    const limited = await raw(
      await get(`/api/apps/${APP_ID}/tables/lvl0/records/${chainRows[0]}`, deep.cookie),
    );
    const cyclic = await raw(
      await get(`/api/apps/${APP_ID}/tables/cyc_a/records/${cycARow}`, deep.cookie),
    );
    const invisible = await raw(
      await get(`/api/apps/${APP_ID}/tables/plain/records/${plainRow}`, deep.cookie),
    );

    expect({
      limitStatus: limited.status,
      limitSaysLimit: limited.body.includes(LIMIT_SENTENCE),
      cycleStatus: cyclic.status,
      cycleSaysLimit: cyclic.body.includes(LIMIT_SENTENCE),
      invisibleStatus: invisible.status,
      invisibleSaysLimit: invisible.body.includes(LIMIT_SENTENCE),
    }).toEqual({
      // **(a) 上限に当たった** —— 4xx + 上限の種別。
      limitStatus: 400,
      limitSaysLimit: true,
      // **(b) 循環した** —— **正常完了。** 環の中(B)の付与が A まで届く。
      cycleStatus: 200,
      cycleSaysLimit: false,
      // **(c) 本当に見えない** —— 404。**上限の文面を1文字も持たない。**
      invisibleStatus: 404,
      invisibleSaysLimit: false,
    });

    // **(a) と (c) は同じ「読めない」だが、応答の形が違う。**
    expect(limited.status).not.toBe(invisible.status);
    // **上限の種別が (a) にだけ載る。**
    expect(limited.body).toContain("段数");
    expect(invisible.body).not.toContain("段数");
  });

  test("(D-2) 一覧 GET の3組を並べる —— 400 / 200(1件) / 200(0件・エラー本文なし)", async () => {
    const limited = await raw(await get(`/api/apps/${APP_ID}/tables/lvl0/records`, deep.cookie));
    const cyclic = await raw(await get(`/api/apps/${APP_ID}/tables/cyc_a/records`, deep.cookie));
    const invisible = await raw(await get(`/api/apps/${APP_ID}/tables/plain/records`, deep.cookie));

    const recordsOf = (body: string): unknown[] =>
      (JSON.parse(body) as { records?: unknown[] }).records ?? [];

    expect({
      limitStatus: limited.status,
      limitHasRecords: Object.hasOwn(JSON.parse(limited.body) as object, "records"),
      cycleStatus: cyclic.status,
      cycleCount: recordsOf(cyclic.body).length,
      invisibleStatus: invisible.status,
      invisibleCount: recordsOf(invisible.body).length,
      invisibleHasErrors: Object.hasOwn(JSON.parse(invisible.body) as object, "errors"),
    }).toEqual({
      // **(a)** 要求全体が 400。**行の一覧を返さない**(黙って落としていない)。
      limitStatus: 400,
      limitHasRecords: false,
      // **(b)** 正常完了して1件返る。
      cycleStatus: 200,
      cycleCount: 1,
      // **(c)** 200 で0件。**エラー本文を1つも持たない**(= 一覧から落ちるだけ)。
      invisibleStatus: 200,
      invisibleCount: 0,
      invisibleHasErrors: false,
    });
  });

  test("(D-3) 【正直に書く】環の長さが段数の上限を超えると、段数の上限が先に当たる", () => {
    // **`lvl0` → … → `lvl6` の鎖の頂点を `lvl0` に戻して、長さ7の環を作る**(純関数で測る)。
    const rows = Array.from({ length: CHAIN }, (_unused, level) => ({
      _id: `r${level}`,
      parent: `r${(level + 1) % CHAIN}`,
    }));
    const resolution = resolveRecordAccess({
      manifest: manifest(),
      tableId: "lvl0",
      row: rows[0] as Record<string, unknown>,
      actorId: "nobody",
      readRows: () => [],
      readRow: (tableId, recordId) => {
        const level = Number(tableId.replace("lvl", ""));
        return rows[level]?._id === recordId ? (rows[level] as Record<string, unknown>) : undefined;
      },
    });
    // **長さ2の環は正常完了する((D-1) の (b))が、長さ7の環はここで止まる。**
    // **「循環は必ず正常完了する」とは書けない。**
    expect(resolution).toEqual({ kind: "limit_exceeded", limit: "depth" });
  });
});

// ---------------------------------------------------------------------------
// (E) 8経路 —— **打ち切りが 4xx になり、丸められていない**
// ---------------------------------------------------------------------------

describe("V7-M4-T04 (E): 8経路すべてで打ち切りが表に出る(丸められていない)", () => {
  test("(E-1) 7経路の生の応答は、どれも 400 + 上限の文面である", async () => {
    const target = chainRows[0] as string;
    const measured: { no: number; name: string; status: number; saysLimit: boolean }[] = [];
    const record = async (no: number, name: string, response: Response): Promise<void> => {
      const out = await raw(response);
      measured.push({ no, name, status: out.status, saysLimit: out.body.includes(LIMIT_SENTENCE) });
    };

    await record(1, "一覧 GET", await get(`/api/apps/${APP_ID}/tables/lvl0/records`, deep.cookie));
    await record(
      2,
      "単件 GET",
      await get(`/api/apps/${APP_ID}/tables/lvl0/records/${target}`, deep.cookie),
    );
    await record(
      4,
      "PATCH",
      await send(
        "PATCH",
        `/api/apps/${APP_ID}/tables/lvl0/records/${target}`,
        deep.cookie,
        { state: "書き換える" },
        { "if-match": versionOf("lvl0", target) },
      ),
    );
    await record(
      5,
      "DELETE",
      await send(
        "DELETE",
        `/api/apps/${APP_ID}/tables/lvl0/records/${target}`,
        deep.cookie,
        undefined,
        {
          "if-match": versionOf("lvl0", target),
        },
      ),
    );
    await record(
      6,
      "画面の操作起点",
      await send(
        "POST",
        `/api/apps/${APP_ID}/views/lvl0-list/actions/run?workflow=stamp&record=${target}`,
        deep.cookie,
        {},
      ),
    );
    await record(
      7,
      "バッチ",
      await send("POST", `/api/apps/${APP_ID}/batch`, deep.cookie, {
        ops: [
          {
            op: "update",
            table: "lvl0",
            target,
            values: { state: "バッチ" },
            if_match: versionOf("lvl0", target),
          },
        ],
      }),
    );
    await record(
      8,
      "ファイル配信",
      await get(`/api/apps/${APP_ID}/files/${coverFile}`, deep.cookie),
    );

    expect(measured).toEqual([
      { no: 1, name: "一覧 GET", status: 400, saysLimit: true },
      { no: 2, name: "単件 GET", status: 400, saysLimit: true },
      { no: 4, name: "PATCH", status: 400, saysLimit: true },
      { no: 5, name: "DELETE", status: 400, saysLimit: true },
      { no: 6, name: "画面の操作起点", status: 400, saysLimit: true },
      { no: 7, name: "バッチ", status: 400, saysLimit: true },
      { no: 8, name: "ファイル配信", status: 400, saysLimit: true },
    ]);
  });

  test("(E-2) 一覧 GET の`st_owner`側の分岐でも 400 になる(分岐が2本あることを隠さない)", async () => {
    const list = await raw(await get(`/api/apps/${APP_ID}/tables/owned/records`, deep.cookie));
    // **自分の行(`st_owner` = 自分)である** —— **所有者スコープでは落ちない行が、
    //   引き継ぎの上限で 400 になる。** **黙って0件の一覧に丸めていない。**
    const single = await raw(
      await get(`/api/apps/${APP_ID}/tables/owned/records/${ownedRow}`, deep.cookie),
    );
    expect({ list: list.status, single: single.status }).toEqual({ list: 400, single: 400 });
    expect(list.body).toContain(LIMIT_SENTENCE);
    expect(single.body).toContain(LIMIT_SENTENCE);
  });

  test("(E-3) 【正直に書く】`POST` は上限に当たりうる判定を1つも行っていない", async () => {
    // **作成の下見は親を1段も辿らない** —— **`app.ts` の `POST` ハンドラは
    // `judgeRecordAccess` を直接呼んでおり、引き継ぎを辿る `recordAccessJudge` を
    // 1度も呼ばない。** **したがって `POST` では打ち切りが起きようが無い。**
    // **「8経路すべてで 4xx になる」とは書けない。7経路である。**
    const response = await send("POST", `/api/apps/${APP_ID}/tables/lvl0/records`, deep.cookie, {
      title: "作る",
      parent: chainRows[1],
    });
    const out = await raw(response);
    expect(out.status).toBe(201);
    expect(out.body).not.toContain(LIMIT_SENTENCE);

    // **配線の実物でも名指しする** —— **`POST` のハンドラに引き継ぎの配管が1件も無い。**
    const source = await Bun.file(join(PRODUCT_ROOT, "src", "server", "app.ts")).text();
    const start = source.indexOf('app.post("/api/apps/:app_id/tables/:table_id/records"');
    const end = source.indexOf('app.patch("/api/apps/:app_id/tables/:table_id/records/:record_id"');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end).includes("recordAccessJudge(")).toBe(false);
  });

  test("(E-4) 打ち切りを「見えない」に丸めた呼び出しが app.ts に1つも無い", async () => {
    const source = await Bun.file(join(PRODUCT_ROOT, "src", "server", "app.ts")).text();
    // **配管 `recordAccessJudge` の呼び出しの本数と、`limit_exceeded` を 4xx へ翻訳する
    //   `recordAccessLimitError(` の呼び出しの本数を突き合わせる。**
    // **一覧 GET は分岐が2本あるので配管の呼び出しは8件で、翻訳も8件である。**
    const countIn = (needle: string): number => source.split(needle).length - 1;
    const pipeCalls = countIn("recordAccessJudge(") - countIn("function recordAccessJudge(");
    // **配管の呼び出し1件につき翻訳が1件ある** —— **1件でも欠けたら、その経路は
    //   打ち切りを黙って「見えない」に丸めていることになる。**
    // **8件の内訳**: **7経路**(一覧 GET / 単件 GET / PATCH / DELETE / 画面の操作起点 /
    //   バッチ / ファイル配信)**+ 一覧 GET の2本目の分岐**(`st_owner` と同居する表)。
    // **`POST` は配管を1度も呼ばないので、この8件に入らない**((E-3) が名指ししている)。
    // **【`V7-M5-T02`(`Z-G19`)による更新。旧文を1バイトも消していない】**
    // **旧: `expect({ pipeCalls, translations: countIn("recordAccessLimitError(") })`**
    // **`.toEqual({ pipeCalls: 8, translations: 8 });`。**
    // **運営専用の口(`GET …/unreachable-records`)が、配管ではなく
    //   `resolveRecordWithoutGrants(`(引き継ぎのどの段にも付与が無いか)を呼ぶ。**
    // **あちらも同じ辿り(`walkAccessInheritance`)を通るので `limit_exceeded` を返しうる**
    //   —— **したがって翻訳が1件増えて9件になった。**
    // **【緩めていない。突き合わせる相手を1本増やしただけである】** —— **「打ち切りを
    //   返しうる呼び出しの本数」と「4xx へ翻訳する本数」が一致することを、今日も
    //   1件のずれも許さずに見ている。**
    // **`import` 行(`resolveRecordWithoutGrants,`)は開き括弧を持たないので数えない。**
    // **【`V8-M10-T02`(台帳 `Q-G16a`)による更新。旧文を1バイトも消していない】**
    // **旧: `.toEqual({ pipeCalls: 8, orphanScans: 1, translations: 9 });`。**
    // **理由は「実物が変わった」側である** —— **一覧 GET の2本の分岐(`st_owner` と
    //   同居する表 / 行アクセス権の表)が母集団の判定1本に畳まれ、配管の呼び出しが
    //   2件 → 1件、打ち切りの翻訳も 2件 → 1件になった**(8 → 7 / 9 → 8)。
    // **上の「8件の内訳」の逐語のうち「**+ 一覧 GET の2本目の分岐**」は今日は成り立たない**
    //   —— **一覧 GET の配管の呼び出しは1件ちょうどである。**
    // **【緩めていない】** **`pipeCalls + orphanScans === translations` という突き合わせは
    //   1件のずれも許さずに今日も成り立っている**(7 + 1 = 8)。
    //   **打ち切りを「見えない」に丸めた経路は今日も0本である** —— **母集団の判定は
    //   `limit_exceeded` を判別可能なユニオンで返し、一覧 GET はそれを 400 に翻訳する。**
    // **【`V8-M10-T03`(台帳 `Q-G13`)による更新。旧文を1バイトも消していない】**
    // **旧: `.toEqual({ pipeCalls: 7, orphanScans: 1, translations: 8 });`**
    //   (その前は 8 / 1 / 9、さらにその前は 8 / —— / 8)。
    // **理由は「実物が変わった」側である** —— **集計表の口(`GET …/views/:view_id/report`)に
    //   配管の呼び出しが1件増え、打ち切りの翻訳も1件増えた**(7 → 8 / 8 → 9)。
    // **【緩めていない】** **`pipeCalls + orphanScans === translations` は今日も1件のずれも
    //   許さずに成り立つ**(8 + 1 = 9)。**集計表も打ち切りを黙って「見えない」に丸めない**
    //   —— **1行でも上限に当たったら、群を作る前に 400 を返す。**
    const orphanScans = countIn("resolveRecordWithoutGrants(");
    expect({
      pipeCalls,
      orphanScans,
      translations: countIn("recordAccessLimitError("),
    }).toEqual({ pipeCalls: 8, orphanScans: 1, translations: 9 });
    // **`import` 行では呼び出していない**(名前だけを持ち込んでいる)。
    // **【`V8-M10-T05`(台帳 `Q-G17`〜`Q-G19`)による更新。旧の式を1バイトも消していない】**
    // **旧: `expect(source.includes("recordAccessLimitError } from")).toBe(true);`**
    // **`V8-M10-T05` が、同じ `./errors.ts` から `reportLimitError`(集計表そのものの上限を
    //   応答文に翻訳する1本)を一緒に持ち込んだので、綴りが
    //   `recordAccessLimitError, reportLimitError } from` に変わった。**
    // **測っている中身は1ミリも変えていない** —— **「`import` 行に名前は在るが、直後に
    //   `(` は無い(= 上の `translations` の数に import 行が混ざっていない)」ことを、
    //   並び順に依存しない形で見る。**
    // **【集計表の上限は `translations` の 9 に入らない】** —— **別の関数
    //   (`reportLimitError`)であり、引き継ぎの打ち切りを丸めた経路の数え上げとは無関係である。**
    const errorsImportLine = source
      .split("\n")
      .find((line) => line.includes('} from "./errors.ts";'));
    expect(errorsImportLine ?? "").toContain("recordAccessLimitError");
    expect(errorsImportLine ?? "").not.toContain("recordAccessLimitError(");
    // **`limit_exceeded` を 404 に混ぜている行が1つも無い。**
    expect(/limit_exceeded[^\n]*\n[^\n]*unknownRecordError/.test(source)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (F) 上限の置き場所 —— **`src/server/` の定数であり、`schemas/` に無い**
// ---------------------------------------------------------------------------

describe("V7-M4-T04 (F): 上限は `src/server/` の定数であって語彙ではない", () => {
  test("(F-1) 定数2本が `src/server/owner-scope.ts` に在る", async () => {
    const source = await Bun.file(join(PRODUCT_ROOT, "src", "server", "owner-scope.ts")).text();
    expect(source).toContain("export const MAX_RECORD_ACCESS_INHERIT_DEPTH = 5;");
    expect(source).toContain("export const MAX_RECORD_ACCESS_INHERIT_ROWS = 1000;");
  });

  test("(F-2) 上限の名前が `schemas/` に1件も現れない(宣言可能にしていない)", async () => {
    const schema = await Bun.file(join(PRODUCT_ROOT, "schemas", "manifest.schema.json")).text();
    expect(schema.includes("MAX_RECORD_ACCESS_INHERIT_DEPTH")).toBe(false);
    expect(schema.includes("MAX_RECORD_ACCESS_INHERIT_ROWS")).toBe(false);
    // **【正直に書く。起票の検証方法は今日の実物と食い違っている】**
    // **起票は「`grep -n \"1000\" schemas/` が0件」と書いているが、`schemas/` には
    //   着手前から「1000 行」の記述が実在する**(ワークフローの1回の発火で処理する行数の
    //   上限。v7 とは無関係)。**したがってその検査は着手前からすでに偽である。**
    // **代わりに測っているのは「`schemas/` を1バイトも変えていないこと」であり、
    //   それは `git diff --numstat <着手前 sha>..HEAD -- schemas/` が空であることで示す
    //   (テストではなく記録の側で貼る)。**
    expect(schema.includes("1000 行")).toBe(true);
  });

  test("(F-3) 上限を宣言するキーが `$defs/table.access_control` に1つも無い", async () => {
    const schema = JSON.parse(
      await Bun.file(join(PRODUCT_ROOT, "schemas", "manifest.schema.json")).text(),
    ) as {
      $defs: { table: { properties: { access_control: { properties: Record<string, unknown> } } } };
    };
    expect(Object.keys(schema.$defs.table.properties.access_control.properties).sort()).toEqual(
      [
        "creator_permission",
        "enabled",
        "grant",
        "groups",
        "inherit_from",
        "members",
        "permissions",
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// (G) **画面にも出る** —— 完了条件 (i) の「画面にもエラー本文にも出る」
// ---------------------------------------------------------------------------

/**
 * **`web/` を1バイトも変えずに満たしているかを確かめる。**
 *
 * **表示層は「サーバが返した `message` / `hint` をそのまま出す」既存の経路を持つ**
 * (`ADR-0003` §3。**要約して捨てない**)。**本タスクはその経路に乗っているだけであり、
 * `web/` に差分を1バイトも出していない。** **それを機械で確かめる**:
 *
 *  1. **`api.ts` が 4xx の本文の `errors` 配列をそのまま `ApiError` に載せる。**
 *  2. **`async.ts` の `toValidationErrors` が `ApiError` の `errors` をそのまま返す。**
 *  3. **一覧画面・詳細画面が `state.errors` をそのまま `ErrorList` に渡す。**
 *  4. **`ErrorList` が `message` と `hint` を DOM に出す**(**実際に描いて確かめる**)。
 */
describe("V7-M4-T04 (G): 上限の文面が画面にも出る(`web/` を1バイトも変えていない)", () => {
  test("(G-1) 表示層は 4xx の `errors` をそのまま `ErrorList` まで運ぶ(4本の鎖)", async () => {
    const api = await Bun.file(join(PRODUCT_ROOT, "web", "src", "api.ts")).text();
    const async_ = await Bun.file(join(PRODUCT_ROOT, "web", "src", "async.ts")).text();
    const list = await Bun.file(
      join(PRODUCT_ROOT, "web", "src", "views", "ListViewRenderer.tsx"),
    ).text();
    const detail = await Bun.file(
      join(PRODUCT_ROOT, "web", "src", "views", "DetailViewRenderer.tsx"),
    ).text();
    expect({
      // 1. 本文の `errors` 配列をそのまま `ApiError` に載せる。
      apiCarriesErrors: api.includes("return body.errors as ValidationError[];"),
      // 2. `ApiError` の `errors` をそのまま返す。
      asyncCarriesErrors: async_.includes("return reason.errors;"),
      // 3. 一覧・詳細のどちらも `toValidationErrors` の結果を `state.errors` に載せ、
      //    それをそのまま `ErrorList` に渡す。
      listSetsErrors: list.includes('setState({ status: "error", errors: toValidationErrors('),
      listRendersErrors: list.includes("<ErrorList errors={state.errors} />"),
      detailSetsErrors: detail.includes('setState({ status: "error", errors: toValidationErrors('),
      detailRendersErrors: detail.includes("<ErrorList errors={state.errors} />"),
    }).toEqual({
      apiCarriesErrors: true,
      asyncCarriesErrors: true,
      listSetsErrors: true,
      listRendersErrors: true,
      detailSetsErrors: true,
      detailRendersErrors: true,
    });
  });

  test("(G-2) サーバが返した本文そのものを `ErrorList` に描くと、上限の文面が画面に出る", async () => {
    // **サーバの生の応答をそのまま使う**(文面を検査の側で書き写さない)。
    const response = await get(
      `/api/apps/${APP_ID}/tables/lvl0/records/${chainRows[0]}`,
      deep.cookie,
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { errors: { message: string; hint?: string }[] };

    const [{ createElement }, { renderToStaticMarkup }, { ErrorList }] = await Promise.all([
      import("react"),
      import("react-dom/server"),
      import("../../web/src/ErrorList.tsx"),
    ]);
    // **実際に描く。** **文面は1バイトも書き換えずにサーバの本文をそのまま渡す。**
    const html = renderToStaticMarkup(
      createElement(ErrorList, { errors: body.errors as never }) as never,
    );
    const container = document.createElement("div");
    container.innerHTML = html;
    const text = container.textContent ?? "";
    expect(text).toContain(LIMIT_SENTENCE);
    expect(text).toContain("段数");
    // **hint も画面に出る。**
    expect(text).toContain(body.errors[0]?.hint ?? "(hint が無い)");
    // **内部の記号は画面にも出ない。**
    expect(text.includes("inherit_from")).toBe(false);
    expect(text.includes("Z-G17")).toBe(false);
  });
});
