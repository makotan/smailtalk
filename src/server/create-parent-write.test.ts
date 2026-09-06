/**
 * **`V15-M2-T01` / `CR-G1` / `CR-G3` / `CR-G4` / `CR-G6`**:
 * **`inherit_from` を宣言した表に行を作るには、親の行に書けなければならない。**
 *
 * ## 何を測るか(`docs/plan/v15/03-v15-m2-tasks.md` §1 `V15-M2-T01` の表の逐語)
 *
 * **実 HTTP で叩く**(既存の `access-control-*.test.ts` と同じ作法)。**単件の
 * `POST /api/apps/:app_id/tables/:table_id/records` だけを撃つ** —— **まとめ書き
 * (`POST /batch`)は `V15-M3` の担当であり、本ファイルは1度も叩かない。**
 *
 * **【`V15-M3` による訂正。上の2行は1バイトも消していない】** —— **「本ファイルは
 * 1度も叩かない」は今日も真である。** **偽になったのは「`V15-M3` の担当」を
 * 「まだ誰も掛けていない」と読む読み方のほうである** —— **まとめ書きにも同じ関門が
 * 今日は掛かっており、それを測っているのは
 * `src/server/batch-create-parent-write.test.ts` である。**
 *
 * | # | 何を撃つか | 着手時 |
 * | --- | --- | --- |
 * | `(a-1)` | 親に `write` を持つ人は作れる(`201`) | **緑**(陰性対照) |
 * | `(a-2)` | 親に `read` しか持たない人は作れない(`403`) | 赤 |
 * | `(a-3)` | 親に付与を1件も持たない人は作れない(`403`) | 赤 |
 * | `(a-4)` | 持ち主(`owner`)でも、親に `write` が無ければ作れない | 赤 |
 * | `(b-1)` | `inherit_from` を宣言していない表は今日どおり作れる | **緑**(陰性対照) |
 * | `(b-2)` | `access_control` を宣言していない表は今日どおり作れる | **緑**(陰性対照) |
 * | `(b-3)` | `inherit_from` が名指しした参照が空の行は、この段が掛からない | **緑**(陰性対照) |
 * | `(c-1)` | 親の表が権限の宣言を持たなければ作れない(`D-V15-6`。fail-closed) | 赤 |
 * | `(c-2)` | **その断り文にも内部記号が1文字も無い**(`CP-V15` の点検が足した) | **緑**(式が無かっただけで、文面は今日から作法どおり) |
 * | `(d-1)` | 段数の上限 → `400` + 上限の文面 | 赤 |
 * | `(d-2)` | 行数の上限 → `400` + 上限の文面 | 赤 |
 * | `(d-3)` | 親に書けない `403` は上限の文面を含まない(2つが区別できる) | 赤 |
 * | `(e-1)` | 断り文に内部記号が1文字も無い | 赤 |
 * | `(e-2)` | `ValidationError` のキーが今日どおり4キーの範囲内 | **緑**(陰性対照) |
 * | `(f-1)` | `creatable_by` を宣言すると、その権限名を持たない人は作れない | 赤 |
 * | `(f-2)` | `creatable_by` を宣言していない表では、親への `write` だけで作れる | 赤 |
 *
 * **`V15-M2-T03` の実測を受けて (g) を足した**(葉タスクの表には無い2本)——
 * **`ADR-0405` `CR-G4` 限定2 が「その関門に検査を1本足す(今日0本である)」と命じており、
 * その1本がどこにも無かったためである**:
 *
 * | # | 何を撃つか | 着手時 |
 * | --- | --- | --- |
 * | `(g-1)` | 作った本人に何も渡らない表は、面が許していても `400` | 赤 |
 * | `(g-2)` | 渡る権限があれば今日どおり作れる | **緑**(陰性対照) |
 *
 * **`CP-V15` の独立点検を受けて (i) を足した**(葉タスクの表にも `V15-M6B` にも無い1本)——
 * **`(b-3)` の穴が、そこで止まらずに**壁の内側へ届く**ことを、誰も測っていなかったためである。**
 * **足したのは検査1本だけであり、製品のコードは1バイトも変えていない**(**塞いでいない**):
 *
 * | # | 何を撃つか | 今日 |
 * | --- | --- | --- |
 * | `(i-1)` | 参照を空にして作り、あとから `PATCH` で親を書き入れる | **通る**(`201` → `200`)【限界】 |
 * | `(i-2)` | 同じことを、まとめ書きの `update` op でも行う | **通る**(`201` → `200`)【限界】 |
 *
 * ## **【誇張しない。本ファイルが測っていないこと】**
 *
 *  1. **まとめ書き(`POST /batch`)を1度も叩いていない**(`V15-M3`)。**したがって
 *     「まとめ書きでも止まる」を本ファイルの緑から読み取ってはならない。**
 *     **【`V15-M3` による訂正。上の2行は1バイトも消していない】** —— **今日も
 *     本ファイルの緑からは読み取れない(1度も叩いていないため)が、**まとめ書きでも
 *     実際に止まる**。 **それを測っているのは
 *     `src/server/batch-create-parent-write.test.ts` の13本である。**
 *  2. **MCP / 受信口 / ワークフロー / 島は1度も通していない** —— **`D-V15-3` が
 *     射程外にしたので、その4経路は今日も素通りする**(`ADR-0404` `S3` (1) の7)。
 *  3. **`(b-3)` は穴である。** **`inherit_from` が名指しした参照を空にすれば、この段の壁は
 *     1ミリも掛からない。** **`ADR-0404` §6 の 6 が「越えてはならない線」として名指しした
 *     とおり、塞ぐには改めて門A を通す必要がある** —— **本ファイルはその穴を緑として
 *     固定する**(隠さないために書いている。**「塞いだ」と読まない**)。
 *  4. **性能を1件も測っていない。** **親の行を1件読み、その親から `resolveRecordAccess`
 *     を掛けるので、作成1回あたりに読む表が増える。** **どこで遅くなるかは測っていない。**
 *  5. **画面を1枚も開いていない**(`V15-M6` の担当)。
 *
 * **【`CP-V15` の独立点検による訂正。上の5項は1バイトも消していない】** —— **3 の
 * 「`(b-3)` は穴である」は今日も真だが、**穴の大きさを小さく書いていた**。**
 * **`(b-3)` は「その行に壁が掛からない」で終わらない** —— **作ったあとに `PATCH`(または
 * まとめ書きの `update` op)で親を書き入れれば、その行は**壁の内側**に入る。**
 * **それを測っているのが下の (i) の2本である。**
 *
 * **【`V15-M8` による訂正。上の散文を1バイトも消していない】** —— **直前の2文は今日は
 * 偽である。** **`V15-M8`(`CR-G9` / `ADR-0408`。ユーザ決定 `D-V15-11` の逐語「今回塞ぐ」)が
 * 更新の2経路にも同じ関門を掛けたので、`PATCH` でもまとめ書きの `update` op でも
 * 親を書き入れられない** —— **(i) の2本はその 403 を撃つ形へ打ち直した(旧の名前も旧の
 * 期待値も1バイトも消していない)。**
 * **`(b-3)` そのものは今日も穴である** —— **参照を空にした行は今日も `201` で作れる。**
 *
 * | # | 何を撃つか | 今日 |
 * | --- | --- | --- |
 * | `(j-1)` | 親に書けない人が、更新で親の `_id` を書き入れる | **403** |
 * | `(j-2)` | まとめ書きの `update` op でも同じ | **403** |
 * | `(j-3)` | 親に書ける人は、更新で親を書き入れられる | **200**(陰性対照) |
 * | `(j-4)` | 参照を1文字も変えない更新は、今日どおり通る | **200**(陰性対照) |
 * | `(j-5)` | `inherit_from` を宣言していない表の更新は1ミリも変わらない | **200**(陰性対照) |
 * | `(j-6)` | `creatable_by` の権限名を持たない人は、更新でも書き入れられない | **403** |
 * | `(j-7)` | 更新の断り文に内部記号が1文字も無い | —— |
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
/** **利用者の表に1行も持たない人**(`(e-2)` が今日ある断りを1本使うために要る)。 */
let outsider: ReturnType<typeof seedSession>;

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
  dataRoot = await mkdtemp(join(tmpdir(), "gp-cpw-"));
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
  outsider = seedSession(dataRoot, APP_ID, { role: "editor", username: "outsider" });

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

// ---------------------------------------------------------------------------
// (a) 親への書込を要求する(`CR-G1`)
// ---------------------------------------------------------------------------

describe("V15-M2 (a): 親に書けるかどうかで、作れるかが決まる", () => {
  test("(a-1) 親に `write` を持つ人は作れる(201)【陰性対照】", async () => {
    const out = await create("issues", writer.cookie, { title: "作る", project: projectId });
    expect(out).toEqual({ status: 201, body: out.body });
    expect(out.status).toBe(201);
  });

  test("(a-2) 親に `read` しか持たない人は作れない(403)", async () => {
    const out = await create("issues", reader.cookie, { title: "作る", project: projectId });
    expect(out.status).toBe(403);
  });

  test("(a-3) 親に付与を1件も持たない人は作れない(403)", async () => {
    const out = await create("issues", stranger.cookie, { title: "作る", project: projectId });
    expect(out.status).toBe(403);
  });

  test("(a-4) 持ち主(owner)でも、親に `write` が無ければ作れない(403)", async () => {
    // **運営ロールは前提の関門を迂回しない**(`ADR-0405` §Decision の 4 の表の 6)。
    const out = await create("issues", holder.cookie, { title: "作る", project: projectId });
    expect(out.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// (b) 掛からない表・掛からない行(`CR-G3` の限定1 / 限定6)
// ---------------------------------------------------------------------------

describe("V15-M2 (b): この段が掛からないところは、今日と1ミリも変わらない", () => {
  test("(b-1) `inherit_from` を1本も宣言していない表は今日どおり作れる【陰性対照】", async () => {
    const out = await create("solo", stranger.cookie, { title: "作る", project: projectId });
    expect(out.status).toBe(201);
  });

  test("(b-2) 権限の宣言を持たない表は今日どおり作れる【陰性対照】", async () => {
    const out = await create("plain", stranger.cookie, { title: "作る" });
    expect(out.status).toBe(201);
  });

  test("(b-3) 親を指していない行には、この段が1ミリも掛からない【陰性対照。穴として記録する】", async () => {
    // **【正直に書く。これは穴である】** —— **`inherit_from` が名指しした参照を空にすれば、
    // 親に何の権限も持たない人でも行を作れる。** **`ADR-0404` §6 の 6 が「越えてはならない
    // 線」として名指ししており、塞ぐには改めて門A を通す必要がある。**
    // **【禁止】この緑を「塞いだ」と読まない。**
    const out = await create("issues", stranger.cookie, { title: "親を指さない" });
    expect(out.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// (c) fail-closed —— **親の表が権限を宣言していなければ、誰も作れない**(`D-V15-6`)
// ---------------------------------------------------------------------------

describe("V15-M2 (c): 宣言していない親を持つ表には、誰も行を作れない", () => {
  test("(c-1) 親の表が権限を宣言していなければ作れない(403)", async () => {
    // **【代金を隠さない】** —— **この構成のアプリは、明日から誰もその表に行を作れない。**
    // **持ち主(`owner`)も止まる**(`ADR-0404` §Decision の 4 の5)。
    const asStranger = await create("open_issues", stranger.cookie, {
      title: "作る",
      open_project: openProjectId,
    });
    const asHolder = await create("open_issues", holder.cookie, {
      title: "作る",
      open_project: openProjectId,
    });
    expect({ stranger: asStranger.status, holder: asHolder.status }).toEqual({
      stranger: 403,
      holder: 403,
    });
  });

  test("(c-2) その断り文にも内部記号が1文字も無く、キーも4キーの範囲内である", async () => {
    // **【`CP-V15` の独立点検が見つけた抜け】** —— **壁が出す断り文は3本あるのに、
    // 「内部記号が1文字も無い」を打っていたのは2本だけだった**(`(e-1)` が
    // 「親に書けない」の1本目、`(h-3)` が「名指しの権限名が無い」の2本目)。
    // **3本目(親の表が権限を宣言していない)には、その式が1本も無かった。**
    // **形は上の2本とまったく同じである** —— **同じ作法(`ADR-0404` 限定9)を、
    // 同じ数え方で打っている。**
    const out = await create("open_issues", stranger.cookie, {
      title: "作る",
      open_project: openProjectId,
    });
    expect(out.status).toBe(403);
    for (const symbol of [
      "access_control",
      "creatable_by",
      "inherit_from",
      "creator_permission",
      "judgeCreateParentAccess",
      "ungoverned",
      "open_projects",
      "open_issues",
      "CR-G",
      "D-V15",
      "V15",
    ]) {
      expect({ symbol, leaked: out.body.includes(symbol) }).toEqual({ symbol, leaked: false });
    }
    const parsed = JSON.parse(out.body) as { errors: Record<string, unknown>[] };
    expect(parsed.errors.length).toBeGreaterThan(0);
    for (const error of parsed.errors) {
      for (const key of Object.keys(error)) {
        expect(["path", "message", "hint", "allowed_values"]).toContain(key);
      }
    }
    // **上限の断りとも、他の2本とも混ざっていない。**
    expect(out.body).not.toContain(LIMIT_SENTENCE);
  });
});

// ---------------------------------------------------------------------------
// (d) 3状態 —— **「作れない」と「段数の上限」と「行数の上限」が区別できる**(`CR-G6`)
// ---------------------------------------------------------------------------

describe("V15-M2 (d): 断りの3状態が応答の上で区別できる", () => {
  test("(d-1) 段数の上限に当たったら 400 + 上限の文面(段数)", async () => {
    const out = await create("lvl0", writer.cookie, { title: "作る", parent: chainRows[1] });
    expect(out.status).toBe(400);
    const body = JSON.parse(out.body) as { errors: { message: string; hint: string }[] };
    expect(body.errors[0]?.message).toContain(LIMIT_SENTENCE);
    expect(body.errors[0]?.message).toContain("段数");
    expect(body.errors[0]?.hint).toContain("段数");
  });

  test("(d-2) 行数の上限に当たったら 400 + 上限の文面(件数)", async () => {
    const out = await create("rc", writer.cookie, { title: "作る", parent: rowParent });
    expect(out.status).toBe(400);
    const body = JSON.parse(out.body) as { errors: { message: string; hint: string }[] };
    expect(body.errors[0]?.message).toContain(LIMIT_SENTENCE);
    expect(body.errors[0]?.message).toContain("件数");
  });

  test("(d-3) 親に書けないときの 403 は、上限の文面を1文字も含まない", async () => {
    const denied = await create("issues", reader.cookie, { title: "作る", project: projectId });
    const limited = await create("lvl0", writer.cookie, { title: "作る", parent: chainRows[1] });
    expect({
      denied: { status: denied.status, saysLimit: denied.body.includes(LIMIT_SENTENCE) },
      limited: { status: limited.status, saysLimit: limited.body.includes(LIMIT_SENTENCE) },
    }).toEqual({
      denied: { status: 403, saysLimit: false },
      limited: { status: 400, saysLimit: true },
    });
  });
});

// ---------------------------------------------------------------------------
// (e) 文面の作法(`CR-G1` 限定9)
// ---------------------------------------------------------------------------

describe("V15-M2 (e): 断り文の作法を1つも破っていない", () => {
  test("(e-1) 断り文に内部記号が1文字も無い", async () => {
    const out = await create("issues", reader.cookie, { title: "作る", project: projectId });
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

  test("(e-2) `ValidationError` のキーは今日も4キーの範囲内である【陰性対照】", async () => {
    // **今日すでに `errors` を持つ断り**(利用者の表に行が無い人の 400)と、
    // **本 MS が足す断り**の両方を通す —— **今日から空でない配列を見ている。**
    const existing = await create("solo", outsider.cookie, { title: "作る" });
    const added = await create("issues", reader.cookie, { title: "作る", project: projectId });
    const keysOf = (body: string): string[] => {
      const parsed = JSON.parse(body) as { errors?: Record<string, unknown>[] };
      return (parsed.errors ?? []).flatMap((error) => Object.keys(error));
    };
    expect(existing.status).toBe(400);
    expect(keysOf(existing.body).length).toBeGreaterThan(0);
    for (const key of [...keysOf(existing.body), ...keysOf(added.body)]) {
      expect(["path", "message", "hint", "allowed_values"]).toContain(key);
    }
  });
});

// ---------------------------------------------------------------------------
// (g) fail-closed —— **作った本人に何も渡らない設定を断つ**(`CR-G4` 限定1 / 限定2)
// ---------------------------------------------------------------------------

describe("V15-M2 (g): 作った本人に権限が1つも渡らない表には、行を作れない", () => {
  test("(g-1) 面(役割の規則)が表の書込を許していても 400 で断られる", async () => {
    // **【この検査が今日まで1本も無かったことを、`ADR-0405` が自認している】** ——
    // **`CR-G4` 限定2 の逐語「その関門に検査を1本足す(今日0本である)。`V15-M2` が足す」。**
    //
    // **`deadend` は面の規則で書込を許してある表である**(`manifestWithRoles`)——
    // **それでも断られるのは、この関門が合成(`OR`)より**先**に置かれた前提の関門だから
    // である。** **`V15-M2` より前は `OR` の中に畳まれており、面が許していれば
    // 「作った本人にも見えない行」を作れていた。**
    const out = await create("deadend", writer.cookie, { title: "作る" });
    expect(out.status).toBe(400);
    const body = JSON.parse(out.body) as { errors: { message: string }[] };
    expect(body.errors[0]?.message).toContain("行を作った人に権限が1つも渡らない設定");
    // **上限の断りとは別物である**(文面が混ざっていない)。
    expect(out.body).not.toContain(LIMIT_SENTENCE);
  });

  test("(g-2) 同じ表でも、渡る権限があれば今日どおり作れる(拒否側だけを示さない)", async () => {
    // **`solo` は `creator_permission` が `writer`(読み書きできる)である。**
    const out = await create("solo", writer.cookie, { title: "作る" });
    expect(out.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// (f) `creatable_by` —— **親に書けるだけでは足りない**(`CR-G2` の判定側)
// ---------------------------------------------------------------------------

describe("V15-M2 (f): `creatable_by` を宣言した表は、名指しした権限名を要求する", () => {
  test("(f-1) 名指しされた権限名を持たない人は、親に書けても作れない", async () => {
    const asKeeper = await create("picked", keeper.cookie, { title: "作る", project: projectId });
    const asWriter = await create("picked", writer.cookie, { title: "作る", project: projectId });
    // **`writer` は親に `write` を持っている** —— **それでも作れないのは、宣言が
    // `keeper` だけを名指ししているからである。**
    expect({ keeper: asKeeper.status, writer: asWriter.status }).toEqual({
      keeper: 201,
      writer: 403,
    });
  });

  test("(f-2) 宣言していない表では、親への `write` だけで決まる", async () => {
    const asWriter = await create("issues", writer.cookie, { title: "作る", project: projectId });
    const asReader = await create("issues", reader.cookie, { title: "作る", project: projectId });
    // **`write` が要りかつ足りる** —— **`read` しか無い人は作れず、`write` があれば作れる。**
    expect({ writer: asWriter.status, reader: asReader.status }).toEqual({
      writer: 201,
      reader: 403,
    });
  });
});

// ---------------------------------------------------------------------------
// (h) 断り文を2本に分ける —— **親には書けるが、名指しされた権限名を持たない**
// ---------------------------------------------------------------------------
//
// **`V15-M6B-T03`。根拠は実地の実測(`docs/plan/v15/records/v15-m6.md` §2 の 7b と、
// その直後の「【この文面は、7b では事実として偽である】」)。**
//
// **実地で何が起きたか** —— **親に書込を持つ人が、名指しされた権限名を持たずに作成して
// 403 を受け取り、その本文が「あなたには、指定された元の行を書き換える権限がありません。」
// であった。** **その人は同じ親の行を `PATCH` で実際に書き換えられた(200)。**
// **したがって断り文は事実として偽であった。**
//
// **【この3本は、断りを緩めていない】** —— **止まる人も応答コード(403)も1つも変えない。**
// **変えるのは文面だけである** —— **次の一手が違うからである**
// (`V15-M2` が `ungoverned_parent` に2本目の文面を作ったのとまったく同じ理由)。
describe("V15-M6B (h): 親に書けるのに名指しの権限名が無い人には、別の断り文を返す", () => {
  test("(h-1) その断り文は、親に書けない人への断り文と違う", async () => {
    // **`writer` は親に `write` を持つが、`picked` が名指ししているのは `keeper` である。**
    const named = await create("picked", writer.cookie, { title: "作る", project: projectId });
    // **`reader` はそもそも親に `write` を持たない。**
    const unwritable = await create("issues", reader.cookie, { title: "作る", project: projectId });
    const messageOf = (body: string): { message: string; hint: string } => {
      const parsed = JSON.parse(body) as { errors: { message: string; hint: string }[] };
      return { message: parsed.errors[0]?.message ?? "", hint: parsed.errors[0]?.hint ?? "" };
    };
    // **応答コードは2つとも 403 のままである**(断りを緩めても強めてもいない)。
    expect({ named: named.status, unwritable: unwritable.status }).toEqual({
      named: 403,
      unwritable: 403,
    });
    expect(messageOf(named.body).message).not.toBe(messageOf(unwritable.body).message);
    // **次の一手も違う** —— **同じ hint にすると、渡してもらう権限を取り違える。**
    expect(messageOf(named.body).hint).not.toBe(messageOf(unwritable.body).hint);
  });

  test("(h-2) その人は実際に親の行を書き換えられるので、書き換えられないとは書かない", async () => {
    const named = await create("picked", writer.cookie, { title: "作る", project: projectId });
    expect(named.status).toBe(403);
    // **【嘘を撃つ式】** —— **実地で偽だった文そのものを名指しで禁じる。**
    expect(named.body).not.toContain("指定された元の行を書き換える権限がありません");
    // **【陽性対照】その人が本当に親を書き換えられることを、この場で打つ。**
    const seen = await app.request(`/api/apps/${APP_ID}/tables/projects/records/${projectId}`, {
      headers: { cookie: writer.cookie, origin: TEST_ORIGIN },
    });
    expect(seen.status).toBe(200);
    const version = ((await seen.json()) as { record: { _updated_at: string } }).record._updated_at;
    const patched = await app.request(`/api/apps/${APP_ID}/tables/projects/records/${projectId}`, {
      method: "PATCH",
      headers: {
        cookie: writer.cookie,
        origin: TEST_ORIGIN,
        "content-type": "application/json",
        "if-match": version,
      },
      body: JSON.stringify({ title: "親を書き換えられる" }),
    });
    expect(patched.status).toBe(200);
    // **親に書けない人(`reader`)への文面のほうは、今日も逐語のままである** ——
    // **打ち直したのは新しい状態の1本だけであり、既存の文面を1バイトも書き換えていない。**
    const unwritable = await create("issues", reader.cookie, { title: "作る", project: projectId });
    expect(unwritable.body).toContain("指定された元の行を書き換える権限がありません");
  });

  test("(h-3) 新しい断り文にも内部記号が1文字も無く、キーも4キーの範囲内である", async () => {
    const out = await create("picked", writer.cookie, { title: "作る", project: projectId });
    expect(out.status).toBe(403);
    for (const symbol of [
      "access_control",
      "creatable_by",
      "inherit_from",
      "creator_permission",
      "judgeCreateParentAccess",
      "projects",
      "picked",
      "keeper",
      "writer",
      "CR-G",
      "V15",
    ]) {
      expect({ symbol, leaked: out.body.includes(symbol) }).toEqual({ symbol, leaked: false });
    }
    const parsed = JSON.parse(out.body) as { errors: Record<string, unknown>[] };
    expect(parsed.errors.length).toBeGreaterThan(0);
    for (const error of parsed.errors) {
      for (const key of Object.keys(error)) {
        expect(["path", "message", "hint", "allowed_values"]).toContain(key);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// (i) 【限界】2段で壁の内側に入れる —— **作成の関門は作成の経路にしか無い**
// ---------------------------------------------------------------------------
//
// **【何が起きるか。平たく書く】** —— **`inherit_from` を宣言した表に、親の参照を
// 空にしたまま行を作り**(これは `(b-3)` の穴であり、今日 `201` で通る)、**その直後に
// その行を `PATCH` して親の `_id` を書き入れると、`200` で通る。**
// **その親は、その人が1ミリも書けない親である** —— **同じ親を名指しして直に作れば
// `403` で断られるのに、2手に分ければ同じ行が出来上がる。**
// **出来上がった行は「壁の内側」に居る** —— **その親に付与を持つ他人(`reader` /
// `writer`)から `200` で読めるようになる(下で実際に打っている)。**
//
// **【なぜ通るか】** —— **作成の関門(`judgeCreateParentAccess`)を呼んでいるのは、
// 単件の作成と、まとめ書きの `create` op の2箇所だけである。**
// **`PATCH` の handler も、まとめ書きの `update` op も、親の参照を1度も見ない。**
// **`batch-create-parent-write.test.ts` の冒頭が「`update` op / `delete` op には
// 1バイトも掛からない」と書いているのは、まさにこのことである** —— **本 (i) は、
// その1行が「穴として何を意味するか」を実測で固定しているだけである。**
//
// **【禁止。この緑を読み違えない】**
//  1. **これは**塞いでいない**。** **緑は「今日はこう通る」を固定しているだけであり、
//     「安全である」でも「直った」でもない。**
//  2. **塞ぐのは本バージョン(`v15`)の仕事ではない。** **`ADR-0404` §6 の 6 が
//     `(b-3)` を「越えてはならない線」として名指ししており、`D-V15-3` は書込の経路を
//     HTTP の作成2本に絞っている。** **`PATCH` / `update` op に同じ関門を掛けることは、
//     止まる人が増える変更であって、改めて門A を通す必要がある。**
//  3. **この2本が赤くなったら、それは「壊れた」ではなく「塞がった」かもしれない。**
//     **赤を見たら、まずどちらであるかを確かめること。**
//
// **【`V15-M8-T03` による訂正。上の散文を1バイトも消していない】**
//
// **3 が起きた。** **この2本は `V15-M8` の実装で実際に赤くなり、確かめた結果は
// 「塞がった」のほうであった** —— **赤の中身は「`200` を期待したのに `403` が返った」で
// あり、壊れたのではなく、断られるようになったのである。**
//
// **したがって 1 と 2 は今日は偽である**(旧文は1バイトも消していない):
//  - **1(「これは塞いでいない」)は偽になった。** **塞いだのは `V15-M8` であり、
//    根拠は **ユーザ決定 `D-V15-11`**(逐語「今回塞ぐ」)と **`ADR-0408`**
//    (`ADR-0404` の限定7 / 限定13 を引き直した。双方向の `amended_by`)である。**
//  - **2(「塞ぐのは本バージョンの仕事ではない」)も偽になった。** **`V15-M8` は同じ
//    バージョン `v15` の中の段である。** **ただし「改めて門A を通す必要がある」の部分は
//    今日も真であり、実際に通した** —— **審査記録は
//    `docs/plan/v15/records/v15-m8.md` §1 である。**
//
// **【何が塞がっていないかも同時に書く。丸めない】**
//  - **`(b-3)`(参照を空のまま作れる)は今日も開いている**(`ADR-0404` §6 の 6)——
//    **下の2本の1手目(`201`)は今日も緑である。**
//  - **参照を**空にする**更新(壁の内側から抜き出す)は今日も通る**(`ADR-0408` §限界3)。
//
// **【下の2本の打ち直し方】** —— **旧のテスト名も、旧の期待値も、1バイトも消していない。**
// **旧は逐語でコメントに残し、今日の正を撃つ式を並べた**(既知の躓き「逐語の残置が検査を
// 騙す」を避けるため、名前も今日の正へ打ち直した)。
describe("V15 (i): 【限界】参照を空にして作ってから親を書き入れると、壁の内側に入れる", () => {
  // **【`V15-M8-T03` による打ち直し。旧のテスト名を1文字も消していない】**
  // **旧(逐語)**: `test("(i-1) 【限界】単件の \`PATCH\` で、書けない親を後から書き入れられる(201 → 200)", …)`
  test("(i-1) 【`V15-M8` が塞いだ】単件の `PATCH` で親を書き入れると断られる(201 → 403)", async () => {
    // **【陽性対照】同じ人が同じ親を名指しして直に作ると、今日は止まる。**
    const direct = await create("issues", stranger.cookie, {
      title: "直に作る",
      project: projectId,
    });
    expect(direct.status).toBe(403);

    // **段1: 参照を空にして作る**(`(b-3)` の穴。作った本人には `writer` が渡る)。
    const created = await create("issues", stranger.cookie, { title: "親を指さない" });
    expect(created.status).toBe(201);
    const row = (JSON.parse(created.body) as { record: { _id: string; _updated_at: string } })
      .record;

    // **段2: その行を `PATCH` して、書けない親の `_id` を書き入れる。**
    const patched = await app.request(`/api/apps/${APP_ID}/tables/issues/records/${row._id}`, {
      method: "PATCH",
      headers: {
        cookie: stranger.cookie,
        origin: TEST_ORIGIN,
        "content-type": "application/json",
        "if-match": row._updated_at,
      },
      body: JSON.stringify({ project: projectId }),
    });
    // **【`V15-M8` による打ち直し。旧の式を1バイトも消していない】**
    // **旧(逐語)**: `expect(patched.status).toBe(200);`
    expect(patched.status).toBe(403);

    // **ディスクの上でも、親が実際に入っている**(応答だけを見て済ませない)。
    const stored = withDb(
      (db) =>
        db.query(`SELECT project FROM issues WHERE _id = ?`).get(row._id) as {
          project: string | null;
        },
    );
    // **【`V15-M8` による打ち直し】** **旧(逐語)**: `expect(stored.project).toBe(projectId);`
    // **今日の正**: **断られたので、ディスクの上にも1文字も書かれていない。**
    expect(stored.project).toBe(null);

    // **【これが「壁の内側」の意味である】** —— **その親に付与を持つ他人から読める。**
    const readAs = async (cookie: string): Promise<number> =>
      (
        await app.request(`/api/apps/${APP_ID}/tables/issues/records/${row._id}`, {
          headers: { cookie, origin: TEST_ORIGIN },
        })
      ).status;
    // **【`V15-M8` による打ち直し】** **旧(逐語)**:
    //     `}).toEqual({ reader: 200, writer: 200, holder: 404, outsider: 404 });`
    // **今日の正**: **その行は壁の内側に入っていないので、親に付与を持つ2人からも見えない。**
    // **`holder` / `outsider` の 404 は着手前と1ミリも変わっていない**(緩めても強めてもいない)。
    expect({
      reader: await readAs(reader.cookie),
      writer: await readAs(writer.cookie),
      // **親に付与を持たない人からは、今日も見えない**(穴の大きさを誇張しない)。
      holder: await readAs(holder.cookie),
      outsider: await readAs(outsider.cookie),
    }).toEqual({ reader: 404, writer: 404, holder: 404, outsider: 404 });
  });

  // **【`V15-M8-T03` による打ち直し。旧のテスト名を1文字も消していない】**
  // **旧(逐語)**: `test("(i-2) 【限界】まとめ書きの \`update\` op でも、まったく同じことができる(201 → 200)", …)`
  // **【版の照合が要らないことは今日も真である】** —— **この口は `If-Match` を1度も
  // 要求しない。** **変わったのは、親の関門で断られるようになったことだけである。**
  test("(i-2) 【`V15-M8` が塞いだ】まとめ書きの `update` op でも断られる(201 → 403)", async () => {
    const created = await create("issues", stranger.cookie, { title: "親を指さない(まとめ書き)" });
    expect(created.status).toBe(201);
    const row = (JSON.parse(created.body) as { record: { _id: string } }).record;

    const response = await app.request(`/api/apps/${APP_ID}/batch`, {
      method: "POST",
      headers: { cookie: stranger.cookie, origin: TEST_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({
        ops: [{ op: "update", table: "issues", target: row._id, values: { project: projectId } }],
      }),
    });
    // **【`V15-M8` による打ち直し。旧の式を1バイトも消していない】**
    // **旧(逐語)**: `expect(response.status).toBe(200);`
    expect(response.status).toBe(403);

    const stored = withDb(
      (db) =>
        db.query(`SELECT project FROM issues WHERE _id = ?`).get(row._id) as {
          project: string | null;
        },
    );
    // **【`V15-M8` による打ち直し】** **旧(逐語)**: `expect(stored.project).toBe(projectId);`
    expect(stored.project).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// (j) 更新の口からの回り込みを塞ぐ(`V15-M8` / `CR-G9` / `ADR-0408`)
// ---------------------------------------------------------------------------
//
// **【何を変えるか。平たく書く】** —— **上の (i) が固定した2手の回り込みを止める。**
// **`inherit_from` を宣言した表で、更新の要求が親の参照の値を**書き換える**とき、
// 作成とまったく同じ関門(親の行に書けるか)を掛ける。**
//
// **【出どころ】** —— **ユーザ決定 `D-V15-11`(逐語「今回塞ぐ」。
// `docs/plan/v15/01-decisions.md` §9)。** **門の判定は
// `docs/plan/v15/records/v15-m8.md` §1、条文は `ADR-0408`(`ADR-0404` の限定7 / 限定13 を
// 引き直す。双方向の `amended_by`)。**
//
// **【この段が塞がないもの。先に書く(憲法6)】**
//  1. **参照を空のまま行を作れる穴(`(b-3)`)は今日も開いている**(`ADR-0404` §6 の 6)——
//     **塞いだのは2手目だけである。**
//  2. **古い親の側を1度も見ない** —— **参照を**空にする**更新(壁の内側から抜き出す)は
//     今日も通る**(`ADR-0408` §限界3)。
//  3. **MCP / 受信口 / ワークフロー / 島は今日も素通りする**(`D-V15-3`)。
//  4. **`DELETE` には1バイトも掛けていない。**
//
// | 記号 | 何を撃つか | 着手前 |
// | --- | --- | --- |
// | `(j-1)` | 親に書けない人が、更新で親の `_id` を書き入れる | **今日 200。塞ぐと 403** |
// | `(j-2)` | まとめ書きの `update` op でも同じ | **今日 200。塞ぐと 403** |
// | `(j-3)` | 親に書ける人は、更新で親を書き入れられる | **緑のまま**(陰性対照) |
// | `(j-4)` | 参照を1文字も変えない更新は、今日どおり通る | **緑のまま**(陰性対照) |
// | `(j-5)` | `inherit_from` を宣言していない表の更新は1ミリも変わらない | **緑のまま**(陰性対照) |
// | `(j-6)` | `creatable_by` の権限名を持たない人は、更新でも書き入れられない | **今日 200。塞ぐと 403** |
// | `(j-7)` | 断り文に内部記号が1文字も無い | —— |
describe("V15-M8 (j): 更新で親を書き入れる要求にも、作成と同じ関門が掛かる", () => {
  /** **単件の `PATCH` を1回叩く**(**版は直前に読んで取る**。生の応答を返す)。 */
  const patch = async (
    table: string,
    recordId: string,
    cookie: string,
    values: Record<string, unknown>,
  ): Promise<{ status: number; body: string }> => {
    const seen = await app.request(`/api/apps/${APP_ID}/tables/${table}/records/${recordId}`, {
      headers: { cookie, origin: TEST_ORIGIN },
    });
    const version =
      seen.status === 200
        ? ((await seen.json()) as { record: { _updated_at: string } }).record._updated_at
        : "";
    const response = await app.request(`/api/apps/${APP_ID}/tables/${table}/records/${recordId}`, {
      method: "PATCH",
      headers: {
        cookie,
        origin: TEST_ORIGIN,
        "content-type": "application/json",
        "if-match": version,
      },
      body: JSON.stringify(values),
    });
    return { status: response.status, body: await response.text() };
  };

  /** **まとめ書きの `update` op を1回叩く**(**版の照合は要らない** —— `(i-2)` の実測)。 */
  const batchUpdate = async (
    table: string,
    recordId: string,
    cookie: string,
    values: Record<string, unknown>,
  ): Promise<{ status: number; body: string }> => {
    const response = await app.request(`/api/apps/${APP_ID}/batch`, {
      method: "POST",
      headers: { cookie, origin: TEST_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ ops: [{ op: "update", table, target: recordId, values }] }),
    });
    return { status: response.status, body: await response.text() };
  };

  /** **参照を空にしたまま1行作る**(`(b-3)` の穴。**今日も 201 で通る**)。 */
  const createOrphan = async (table: string, cookie: string): Promise<string> => {
    const created = await create(table, cookie, { title: "親を指さない" });
    expect(created.status).toBe(201);
    return (JSON.parse(created.body) as { record: { _id: string } }).record._id;
  };

  /** **ディスクの上で親が入っているか**(応答だけを見て済ませない)。 */
  const storedParent = (table: string, recordId: string): string | null =>
    withDb(
      (db) =>
        (
          db.query(`SELECT project FROM ${table} WHERE _id = ?`).get(recordId) as {
            project: string | null;
          }
        ).project,
    );

  test("(j-1) 親に書けない人は、更新で親の `_id` を書き入れられない(403)", async () => {
    const rowId = await createOrphan("issues", stranger.cookie);
    const out = await patch("issues", rowId, stranger.cookie, { project: projectId });
    expect(out.status).toBe(403);
    // **ディスクの上でも入っていない**(応答だけを見て済ませない)。
    expect(storedParent("issues", rowId)).toBe(null);
    // **【これが「壁の内側に入っていない」の意味である】** —— **その親に付与を持つ他人から
    // 見えないままである**((i-1) が 200 を実測した2人を、そのまま撃つ)。
    const readAs = async (cookie: string): Promise<number> =>
      (
        await app.request(`/api/apps/${APP_ID}/tables/issues/records/${rowId}`, {
          headers: { cookie, origin: TEST_ORIGIN },
        })
      ).status;
    expect({ reader: await readAs(reader.cookie), writer: await readAs(writer.cookie) }).toEqual({
      reader: 404,
      writer: 404,
    });
  });

  test("(j-2) まとめ書きの `update` op でも、同じように断られる(403)", async () => {
    const rowId = await createOrphan("issues", stranger.cookie);
    const out = await batchUpdate("issues", rowId, stranger.cookie, { project: projectId });
    expect(out.status).toBe(403);
    expect(storedParent("issues", rowId)).toBe(null);
  });

  test("(j-3) 親に書ける人は、更新で親を書き入れられる(200)【陰性対照】", async () => {
    const rowId = await createOrphan("issues", writer.cookie);
    const out = await patch("issues", rowId, writer.cookie, { project: projectId });
    expect(out.status).toBe(200);
    expect(storedParent("issues", rowId)).toBe(projectId);
    // **まとめ書きの側も同じである**(片方だけ通ることを作らない)。
    const other = await createOrphan("issues", writer.cookie);
    const batched = await batchUpdate("issues", other, writer.cookie, { project: projectId });
    expect(batched.status).toBe(200);
    expect(storedParent("issues", other)).toBe(projectId);
  });

  test("(j-4) 参照を1文字も変えない更新は、今日どおり通る(200)【陰性対照】", async () => {
    // **題材**: **親を指している行に、その親へ書けない人が付与を持っている。**
    // **`(j-1)` の道では作れないので、ディスクに直接置く** —— **測りたいのは
    // 「参照を変えない更新に1ミリも掛からない」ことだけである。**
    const loaded = manifest();
    const rowId = withDb((db) => {
      const created = createRecord(db, loaded, "issues", {
        title: "既に親を指す",
        project: projectId,
      });
      const id = (created as { value: { _id: string } }).value._id;
      const member = db
        .query(`SELECT _id FROM ac_member WHERE account = ?`)
        .get(stranger.userId) as {
        _id: string;
      };
      expect(
        createRecord(db, loaded, "ac_grant", {
          issue: id,
          member: member._id,
          permission: "writer",
        }).ok,
      ).toBe(true);
      return id;
    });

    // **(1) 参照を1つも送らない更新** —— **今日どおり通る。**
    const untouched = await patch("issues", rowId, stranger.cookie, { title: "件名だけ変える" });
    // **(2) 同じ参照を送り直す更新**(値が1文字も変わらない)—— **今日どおり通る。**
    // **【これが無いと壊れるもの】** **画面は行を読んでそのまま書き戻す** ——
    // **送り直しで止めると、親を持つ行が誰にも更新できなくなる。**
    const resent = await patch("issues", rowId, stranger.cookie, {
      title: "送り直す",
      project: projectId,
    });
    // **(3) まとめ書きの側も同じである。**
    const batched = await batchUpdate("issues", rowId, stranger.cookie, { title: "まとめ書き" });
    expect({
      untouched: untouched.status,
      resent: resent.status,
      batched: batched.status,
    }).toEqual({ untouched: 200, resent: 200, batched: 200 });
    expect(storedParent("issues", rowId)).toBe(projectId);
  });

  test("(j-5) `inherit_from` を宣言していない表の更新は1ミリも変わらない(200)【陰性対照】", async () => {
    // **`solo` は `access_control` を宣言しているが `inherit_from` を1本も持たない。**
    // **同じ `project` の参照項目を持っているので、「参照を書き入れる更新」を同じ形で撃てる。**
    const created = await create("solo", stranger.cookie, { title: "引き継がない表" });
    expect(created.status).toBe(201);
    const rowId = (JSON.parse(created.body) as { record: { _id: string } }).record._id;
    const out = await patch("solo", rowId, stranger.cookie, { project: projectId });
    expect(out.status).toBe(200);
    expect(storedParent("solo", rowId)).toBe(projectId);
  });

  test("(j-6) 名指しされた権限名を持たない人は、更新でも書き入れられない(403)", async () => {
    // **`picked` は `creatable_by: ["keeper"]` を宣言している。**
    // **`writer` は親に `write` を持つが `keeper` は持たない。**
    const rowId = await createOrphan("picked", writer.cookie);
    const denied = await patch("picked", rowId, writer.cookie, { project: projectId });
    expect(denied.status).toBe(403);
    expect(storedParent("picked", rowId)).toBe(null);
    // **【陽性対照】名指しされた権限名を持つ人は書き入れられる**(拒否側だけを示さない)。
    const keeperRow = await createOrphan("picked", keeper.cookie);
    const allowed = await patch("picked", keeperRow, keeper.cookie, { project: projectId });
    expect(allowed.status).toBe(200);
    expect(storedParent("picked", keeperRow)).toBe(projectId);
  });

  test("(j-7) 更新の断り文にも内部記号が1文字も無く、キーも4キーの範囲内である", async () => {
    const rowId = await createOrphan("issues", stranger.cookie);
    const out = await patch("issues", rowId, stranger.cookie, { project: projectId });
    expect(out.status).toBe(403);
    for (const symbol of [
      "access_control",
      "creatable_by",
      "inherit_from",
      "creator_permission",
      "judgeCreateParentAccess",
      "projects",
      "issues",
      "writer",
      "CR-G",
      "V15",
    ]) {
      expect({ symbol, leaked: out.body.includes(symbol) }).toEqual({ symbol, leaked: false });
    }
    const parsed = JSON.parse(out.body) as { errors: Record<string, unknown>[] };
    expect(parsed.errors.length).toBeGreaterThan(0);
    for (const error of parsed.errors) {
      for (const key of Object.keys(error)) {
        expect(["path", "message", "hint", "allowed_values"]).toContain(key);
      }
    }
  });
});
