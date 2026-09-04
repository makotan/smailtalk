/**
 * **`V7-M2-T03` / `Z-G13`**: **運営3ロール・アプリが宣言した利用者の種類と、権限名との優先順位。**
 *
 * **裁定の正は `docs/plan/v7/records/v7-m0.md` §5-4 の (ii)(iii)(iv) と §6-4 の `Z-G13` である。**
 *
 * ## 本ファイルが測るもの
 *
 * - **(A)** **`NonAdminTableAccess` は3値のままである**(§5-4 (ii))——
 *   **4つ目の値を足さない。** **`access_control.enabled` が真の表は `"scoped"` を返す。**
 *   **`"denied"` に黙って落とさない。**
 * - **(B)** **宣言した表では `st_admin_readable` を効かせない**(`D-V7-22` / §5-4 (iii))。
 *   **`st_admin_readable` の宣言粒度は1ミリも動かさない**(`ADR-0061` 限定3)。
 *   **【`V8-M20` / 台帳 `J-G30` / `ADR-0301` / ユーザ決定 `D-V8-35`】`st_admin_readable` は
 *   廃止された。** **代わりに立つのは面の規則(役割 × 対象(表)× 読取)であり、その入口は
 *   `roleReadCrossesOwnerScope` である。** **(B) は消さずに、面の側で同じことを測る形へ
 *   置き直した** —— **ただし置き直した結果、旧の (B1) が守っていた性質(宣言した表では
 *   運営も付与を迂回しない)は**今日は成り立たない**。** **成り立たないことを (B1) が
 *   そのまま実測して残す**(下の逐語)。
 * - **(C)** **運営ロール(`owner`)が、付与の無い行を `API` から取れない**(完了条件 (ii))。
 *   **付与を1件入れたら見えるようになることも測る** —— **拒否側だけを測ると、全部拒否しても
 *   緑になるからである。** **宣言していない表で `owner` が今日どおり全行を見られること
 *   (オプトインの側)も測る。**
 * - **(D)** **同居の拒否は `V7-M1-T05` が実装済みである** —— **本タスクが実装したのではない。**
 *   **実装済みであることを実測して固定する**(完了条件 (iii))。
 * - **(E)** **宣言された利用者の種類が全部同じ判定を受ける**(`ADR-0158` 限定2 /
 *   `Z-G13` 限定4)—— **`judgeRecordAccess` はロールにも種類にも1バイトも分岐していない。**
 * - **(F)** **項目単位の宣言との重ね順は AND**(§5-4 (iv))—— **運営ロールについても AND。**
 *   **【`V8-M20` / 台帳 `J-G28` / `ADR-0301`】旧は `field.audience` / `field.writable_by` の
 *   2宣言だった。** **どちらも廃止され、面の規則(役割 × 対象(項目)× 読取 / 書込)に
 *   置き直された。** **測る形(行の権限が項目の判定を1バイトも上書きしない)は変えていない。**
 *
 * ## 本ファイルが測らないもの(**誇張しない**)
 *
 * - **`POST` / `DELETE` / 画面の操作起点 / バッチ / ファイル配信の5経路には、今日も判定が
 *   1バイトも掛かっていない**(`V7-M2-T02` の記録 §2-2-6)。**本ファイルはその5経路を
 *   1本も測らない** —— **`nonAdminTableAccess` が `"scoped"` を返すようになった結果、
 *   宣言された種類も `POST` / `DELETE` が中継層を通るようになったことだけを (A) の HTTP で
 *   実測して残す。**
 * - **グループ経由の解決 / 引き継ぎ / 作成者への自動付与は今日も効かない**(`V7-M3` / `V7-M4`)。
 * - **画面(`web/`)を1バイトも触っていない。**
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
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
import { validateManifestFull } from "../kernel/validate.ts";
import { createServerApp } from "./app.ts";
import {
  judgeRecordAccess,
  judgeRoleAccess,
  OWNER_FIELD,
  PUBLIC_FIELD,
  roleGateBlocksWithoutGrants,
  roleReadCrossesOwnerScope,
} from "./owner-scope.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "workshop";
const OWNER_SCOPE_SOURCE = readFileSync(
  new URL("./owner-scope.ts", import.meta.url).pathname,
  "utf8",
);
const APP_SOURCE = readFileSync(new URL("./app.ts", import.meta.url).pathname, "utf8");

/** 権限名2つ。**`read` だけの名前と、`write` も持つ名前。** */
const PERMISSIONS = [
  { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
  { id: "writer", name: "編集できる", read: true, write: true, delete: false },
] as const;

const ACCESS_CONTROL = {
  enabled: true,
  permissions: [...PERMISSIONS],
  creator_permission: "writer",
  grant: {
    table: "work_grant",
    target: "work",
    member: "member",
    permission: "permission",
  },
  members: { table: "work_member", account: "account" },
};

/** 宣言つきの表(**`st_owner` を1本も持たない**)。 */
function declaredTable(): Table {
  return {
    id: "works",
    name: "案件",
    fields: [
      { id: "title", name: "題", type: "text", required: true },
      // **項目単位の判定との AND を測るための2本**(`v7-m0.md` §5-4 (iv))。
      // **【`V8-M20` / `J-G28` / `ADR-0301`】旧はここに宣言が書いてあった** ——
      // **旧: `{ id: "secret", …, audience: ["editor"] }` /
      //   `{ id: "locked", …, writable_by: ["editor"] }`。**
      // **どちらの宣言も廃止されたので、下の `ROLES` の面の規則へ移した。**
      { id: "secret", name: "内部メモ", type: "text" },
      { id: "locked", name: "確定欄", type: "text" },
    ],
    access_control: { ...ACCESS_CONTROL },
  } as unknown as Table;
}

/**
 * **面の規則**(`app.roles`)。**旧の3宣言の置き直し先である**(`V8-M20` / `J-G28` / `J-G30`)。
 *
 * | 旧の宣言 | 置き直し先 |
 * |---|---|
 * | `works.secret` の `audience: ["editor"]` | `editor` に `{target:"field", table:"works", field:"secret", can:["read"]}` |
 * | `works.locked` の `writable_by: ["editor"]` | `editor` に `{target:"field", table:"works", field:"locked", can:["read","write"]}` |
 * | `ledger` の `st_admin_readable` | `owner` に `{target:"table", table:"ledger", can:["read"]}` |
 *
 * **既定3ロール(`owner` / `editor` / `viewer`)は消せないので、規則を持たない `viewer` も
 * 宣言する**(`referential-integrity.ts` の類型17)。
 *
 * **【対象を名指しした時点で全動詞が allow-list になることの副作用を隠さない】**
 * **`ledger` に `can: ["read"]` しか書いていないので、`ledger` への書込・削除は**誰にも**
 * できない。** **本ファイルは `ledger` を `createRecord`(カーネル経路)でしか作らないので
 * 表に出ないが、`HTTP` から書こうとすれば止まる。**
 */
const ROLES = [
  {
    id: "owner",
    name: "運営",
    rules: [{ target: "table", table: "ledger", can: ["read"] }],
  },
  {
    id: "editor",
    name: "編集",
    rules: [
      { target: "field", table: "works", field: "secret", can: ["read"] },
      { target: "field", table: "works", field: "locked", can: ["read", "write"] },
    ],
  },
  { id: "viewer", name: "閲覧" },
  // **【`V8-M29` 第2波】旧(逐語)**: `user_kinds: [{ id: "patient", name: "来訪者" }, { id: "supplier", name: "取引先" }],`
  // **語彙 `app.user_kinds` は廃止された** —— **代わりに立つのは `app.roles`
  // (差分操作 `set_roles`)であり、宣言した独自の役割がそのまま「人に付けられる値」になる。**
  // **規則(`rules`)は1本も書かない** —— **`withDefaultRoleRules` が規則を足すのは
  // 既定3役割だけなので、この2つの面は旧(利用者の種類だった日)と同じく閉じたままである。**
  { id: "patient", name: "来訪者" },
  { id: "supplier", name: "取引先" },
] as const;

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "工房",
      // **宣言された利用者の種類2つは `ROLES` の役割宣言へ移した**(`V8-M29` 第2波)。
      tables: [
        declaredTable(),
        {
          // **宣言していない表**(オプトインの対照。**`owner` は今日どおり全行を見られる**)。
          id: "plain",
          name: "掲示",
          fields: [{ id: "body", name: "本文", type: "text" }],
        },
        {
          // **面の規則で `owner` に読取を開いた表**(`access_control` は宣言していない)。
          // **`owner` は他人の行まで読める** —— **`D-V8-35` の形の対照である。**
          // **【`V8-M20` / `J-G30`】旧はここに `{ id: ADMIN_READABLE_FIELD, name: "運営可視",
          //   type: "boolean" }` を1本立てていた。** **その予約規約フィールドは廃止された。**
          id: "ledger",
          name: "台帳",
          fields: [
            { id: "memo", name: "メモ", type: "text" },
            { id: OWNER_FIELD, name: "所有者", type: "text" },
          ],
        },
        {
          id: "work_member",
          name: "利用者",
          fields: [{ id: "account", name: "ログイン", type: "text" }],
        },
        {
          id: "work_grant",
          name: "付与",
          fields: [
            { id: "work", name: "案件", type: "reference", reference_table: "works" },
            { id: "member", name: "相手", type: "reference", reference_table: "work_member" },
            { id: "permission", name: "権限", type: "select", options: ["reader", "writer"] },
          ],
        },
      ],
      views: [],
      // **【`V8-M20` / `J-G28` / `J-G30`】旧3宣言の置き直し先**(`ROLES` の doc を見よ)。
      roles: ROLES.map((role) => ({ ...role })),
    },
  } as unknown as Manifest;
}

/**
 * **【`V8-M26`】面(役割に束ねた権限)の既定が「閉じる」側へ倒れたので、題材へ規則を足す。**
 *
 * **`V8-M26-T03` 以降、規則を1本も名指ししていない `table` は拒否される。** 実アプリでは
 * `apply-diff.ts` の自動付与が `add_table` のたびに既定3役割へ規則を1本ずつ入れるが、
 * **本ファイルは `applyManifest` を直接呼ぶので差分の畳み込みを1度も通らない。**
 *
 * **足すのは `plain` の1表だけである** —— **`skipTables` に4表を挙げた理由を名指しで書く。**
 *
 * | 除外した表 | 理由 |
 * |---|---|
 * | `works` | **`access_control` を宣言した保護対象の表である。** 面の規則を1本でも足すと `combineRoleAndGrantAccess` の `OR` で面の答えが通り、**(B1) / (C1)〜(C5) / (E-HTTP) / (F) が測っている「行ごとの付与だけで決まる」ことが丸ごと測れなくなる。** |
 * | `ledger` | **`ROLES` が `owner` にだけ手で規則を書いた表である**(旧 `st_admin_readable` の置き直し先)。 helper は `owner` には足さないが **`editor` / `viewer` には足してしまい、(C7) が測る「`editor` は面の allow-list に入っていないので面が止める」が別の層(`st_owner`)の話にすり替わる。** |
 * | `work_member` | **(B2) が「規則を1本も書いていない表」として名指しする表である**(下の逐語を見よ)。 |
 * | `work_grant` | **付与表。本ファイルは `HTTP` から1度も触らず(`grantTo` はカーネル経路)、開ける必要が無い。** |
 *
 * **項目(`field`)の規則は1本も足していない** —— **`ROLES` が `works.secret` /
 * `works.locked` に書いた2本が、(F) の測る対象のまま残る。**
 */
function manifestWithRoles(): Manifest {
  return withDefaultRoleRules(manifest(), {
    skipTables: ["works", "ledger", "work_member", "work_grant"],
  });
}

/** 表を1つだけ差し替えた形を作る(検査用の小道具)。 */
function tableWith(fields: unknown[], accessControl?: unknown): Table {
  const table: Record<string, unknown> = { id: "t", name: "表", fields };
  if (accessControl !== undefined) {
    table.access_control = accessControl;
  }
  return table as unknown as Table;
}

const TITLE_FIELD = { id: "title", name: "題", type: "text" };
// **【`V8-M20` / `J-G30`】旧: `const ADMIN_FIELD = { id: ADMIN_READABLE_FIELD, name: "運営可視",
//   type: "boolean" };`。** **予約規約フィールドごと廃止したので消した。**
// **【`V8-M27-T04` / `T-G5`】`OWNER_SCOPE_FIELD` は使われなくなった** ——
// **旧の (A2) / (A3) / (A4) が `nonAdminTableAccess` の真理値表を作るために使っていた
// 定数であり、その3本ごと撤去した**(旧の逐語は上の置き直しの節に残してある)。
// **旧の宣言(逐語)**: `const OWNER_SCOPE_FIELD = { id: OWNER_FIELD, name: "所有者", type: "text" };`
// **`OWNER_FIELD` の import は残る**((D) 群と (E) 群が今日も使っている)。
const PUBLIC_SCOPE_FIELD = { id: PUBLIC_FIELD, name: "公開", type: "boolean" };

// ---------------------------------------------------------------------------
// (A) `NonAdminTableAccess` は3値のまま(`v7-m0.md` §5-4 (ii) / `Z-G13` 限定3)
// ---------------------------------------------------------------------------

// =====================================================================================
// **【`V8-M27-T04` / `T-G5`。この describe の6本は判定ごと撤去された。旧のテスト名と
//   旧の期待値を逐語で残す。検査は1本も消していない ―― 下の2本に置き換えた】**
//
// **旧の describe 名**: `V7-M2-T03 (A): NonAdminTableAccess は3値のまま(4つ目を足さない)`
//
// **旧のテスト名と旧の期待値(逐語)**:
//
//  (A1) `(A1) 型宣言が逐語で3値である`
//        expect(OWNER_SCOPE_SOURCE).toContain(
//          'export type NonAdminTableAccess = "scoped" | "public" | "denied";');
//        expect(values).toEqual(['"scoped"', '"public"', '"denied"']);
//  (A2) `(A2) 宣言つきの表(st_owner なし)は scoped を返す —— denied に落とさない`
//        expect(nonAdminTableAccess(table)).toBe("scoped");
//        expect(nonAdminTableAccess(table)).not.toBe("denied");
//  (A3) `(A3) 真理値表 —— 宣言と既存2規約の組み合わせで3値だけが返る`
//        expect(nonAdminTableAccess(tableWith([OWNER_SCOPE_FIELD], {...ACCESS_CONTROL}))).toBe("scoped");
//        expect(nonAdminTableAccess(tableWith([TITLE_FIELD], {...ACCESS_CONTROL, enabled: false}))).toBe("denied");
//        expect(nonAdminTableAccess(tableWith([TITLE_FIELD]))).toBe("denied");
//        expect(nonAdminTableAccess(tableWith([PUBLIC_SCOPE_FIELD]))).toBe("public");
//  (A4) `(A4) 返る値は3つの文字列のどれかに閉じている(全形を通しても4つ目が出ない)`
//        expect(["scoped", "public", "denied"]).toContain(value);
//        expect(seen.size).toBeLessThanOrEqual(3);
//  (A5) `(A5) 呼び出し2箇所の分岐が1つも増えていない(集約の形を崩さない)`
//        expect(calls.length).toBe(2);
//        expect(APP_SOURCE.includes("access_control")).toBe(false);
//  (A6) `(A6) 4値目を足さない理由が、実装の側に逐語で残っている`
//        expect(OWNER_SCOPE_SOURCE).toContain("4値目を足すと呼び出し2箇所の分岐が増え、`app.ts` が逐語で述べる");
//        expect(OWNER_SCOPE_SOURCE).toContain("1件でも運営テーブルへ customer の GET/書込を通さないことを、この1箇所の集約で構造保証する");
//        expect(OWNER_SCOPE_SOURCE).toContain('`"denied"` に黙って落とさない');
//
// **根拠**: **`V8-M27` / 台帳 `T-G5` / ユーザ決定 `D-V8-38`。**
// **`nonAdminTableAccess` / `NonAdminTableAccess` は撤去された** ——
// **「運営(予約3ロール)か否か」で表単位の可否を決める層そのものだったためである。**
// **したがって「3値のままか」「4値目を足していないか」を問う余地が無い**(値域ごと消えた)。
//
// **`Z-G13` 限定3 が本当に守っていたのは「アクセス権管理を宣言した表を、行を見る前の
// 中継層で閉じてしまわない」ことである**(= **付与を持っているのに読めない、を作らない**)。
// **その性質は今日も要る。** **今日それを担っているのは `roleGateBlocksWithoutGrants` で
// あり**(`V8-M19` / `D-V8-23` の `OR`)、**下の (A2') がそれを測る。**
// =====================================================================================

describe("V7-M2-T03 (A) の置き直し: 層は撤去され、その役目は面と点の合成が担う", () => {
  test("(A1') `NonAdminTableAccess` / `nonAdminTableAccess` が実装から消えている", () => {
    // **コメント行は除いて数える** —— **旧の宣言は「旧文を1バイトも消さない」という
    // このリポジトリの作法により、撤去の記録としてコメントの中に逐語で残っている。**
    const live = (source: string): string[] =>
      source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
    expect(
      live(OWNER_SCOPE_SOURCE).some((line) => line.includes("export type NonAdminTableAccess")),
    ).toBe(false);
    expect(
      live(OWNER_SCOPE_SOURCE).some((line) =>
        line.includes("export function nonAdminTableAccess("),
      ),
    ).toBe(false);
    // **旧 (A5) の置き直し** —— **呼び出しは 2箇所から 0箇所になった。**
    const calls = APP_SOURCE.split("\n").filter(
      (line) => /nonAdminTableAccess\(/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line),
    );
    expect(calls.length).toBe(0);
    // **`app.ts` に `access_control` の綴りを1件も作らない**(`ADR-0061` 限定4)。**据え置き。**
    expect(APP_SOURCE.includes("access_control")).toBe(false);
  });

  test("(A2') 宣言した表は、面が閉じていても行を見る前に落とされない(付与が届く)", () => {
    // **旧 (A2) が `"scoped"` で守っていた性質の、今日の対応物である。**
    // **面が「管轄内で拒否」を返しても、その表が付与の管轄内なら短絡してはならない** ——
    // **短絡すると `OR` が `AND` に戻り、「付与を持っているのに読めない」が起きる。**
    const blocked = {
      allowed: false,
      governed: true,
      blockedBy: "role",
      conditional: false,
    } as const;
    expect(roleGateBlocksWithoutGrants({ role: blocked, grantGoverned: true })).toBe(false);
    // **宣言していない表(付与の管轄外)では、面の拒否がそのまま効く。**
    expect(roleGateBlocksWithoutGrants({ role: blocked, grantGoverned: false })).toBe(true);
    // **旧 (A3) の「宣言していない運営テーブルは denied」に相当するもの** ——
    // **今日は「規則が1本も無ければ閉じる」であり、表の作りを1ミリも見ない。**
    const manifest = {
      app: {
        id: "x",
        name: "x",
        tables: [tableWith([TITLE_FIELD])],
        views: [],
        roles: [
          { id: "owner", name: "持ち主" },
          { id: "editor", name: "編集者" },
          { id: "viewer", name: "閲覧者" },
        ],
      },
    };
    expect(
      judgeRoleAccess({
        manifest,
        roles: ["owner"],
        target: { target: "table", table: "works" },
        verb: "read",
      }).allowed,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (B) 宣言した表では、面の規則を持つ運営ロールも付与を迂回しない
//     (旧: 宣言した表では `st_admin_readable` を効かせない。`D-V7-22` / §5-4 (iii))
//
// **【`V8-M20` / 台帳 `J-G30` / `ADR-0301` / ユーザ決定 `D-V8-35`】**
// **`st_admin_readable` は廃止され、`adminReadableField` / `adminReadsAllRows` /
//   `ADMIN_READABLE_FIELD` も `owner-scope.ts` から消えた。**
// **検査は「面の側で同じことが言える」形へ置き直した**(消していない)。
// ---------------------------------------------------------------------------

describe("V7-M2-T03 (B): 宣言した表では、面の規則を持つ運営ロールも付与を迂回しない", () => {
  // **旧のテスト名: 「(B1) 宣言つき + st_admin_readable では owner でも false(付与の判定が勝つ)」。**
  // **旧は `adminReadsAllRows(table, role)` の単体で測っていた** ——
  // **その関数が消えたので、同じことを `HTTP` で測る形へ置き直した。**
  // **本フィクスチャの `owner` は面の規則(`ledger` の表読取)を持っている** ——
  // **その面の許しが、`access_control` を宣言した別の表(`works`)へ1ミリも漏れないことを測る。**
  test("(B1) 面の規則を持つ owner でも、宣言した表では付与の無い行を1件も読めない", async () => {
    const list = await get(`/api/apps/${APP_ID}/tables/works/records`, actors.owner.cookie);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { records: unknown[] }).records).toEqual([]);
    const single = await get(
      `/api/apps/${APP_ID}/tables/works/records/${closedRow}`,
      actors.owner.cookie,
    );
    expect(single.status).toBe(404);
    // **面の規則が効いている側**(対照。**拒否側だけを測ると全部拒否でも緑になる**)——
    // **同じ `owner` は `ledger` では他人の行を読める。**
    const ledger = await get(`/api/apps/${APP_ID}/tables/ledger/records`, actors.owner.cookie);
    expect(((await ledger.json()) as { records: { _id: string }[] }).records).toHaveLength(1);
  });

  // **旧のテスト名: 「(B2) 宣言していない表では今日どおり true(オプトインの側を1ミリも動かさない)」。**
  // **旧は `st_admin_readable` を持つ表について `adminReadsAllRows(table, "owner") === true` を
  //   測っていた。** **今日その入口は `roleReadCrossesOwnerScope` である。**
  // **【`V8-M26`】測る表を `plain` → `work_member` へ置き直した(判定は1バイトも変えていない)。**
  // **旧: `const base = manifest();`**
  // **旧: `expect(roleReadCrossesOwnerScope({ manifest: base, roles: "owner", table: "plain" })).toBe(`**
  // **旧:   `false,`**
  // **旧: `);`**
  // **理由: `V8-M26-T03` が「規則を1本も名指ししていない表は拒否」へ倒したので、
  //   適用する題材(`manifestWithRoles`)では `plain` に既定3役割の規則が入る**
  //   (実アプリでは `apply-diff.ts` の自動付与が必ず入れる規則である)。
  //   **`plain` を名指ししたままだと「規則を1本も書いていない表」の例ではなくなる。**
  // **`work_member` は `skipTables` で除外してあり、今日も規則を1本も持たない。**
  // **あわせて `base` を `manifestWithRoles()` にした** —— **実際に適用される題材そのもので
  //   測るためであり、「管轄外の表は誰も越えない」という主張は1ミリも弱めていない。**
  test("(B2) 面の規則を1本も書いていない表では越えない(既定は今日どおり)", () => {
    const base = manifestWithRoles();
    // **規則を書いた表 + 書いた役割 → 越える**(`D-V8-35`)。
    expect(roleReadCrossesOwnerScope({ manifest: base, roles: "owner", table: "ledger" })).toBe(
      true,
    );
    // **同じ表でも、規則を持たない役割は越えない**(allow-list)。
    expect(roleReadCrossesOwnerScope({ manifest: base, roles: "editor", table: "ledger" })).toBe(
      false,
    );
    // **未ログインも越えない。**
    expect(roleReadCrossesOwnerScope({ manifest: base, roles: null, table: "ledger" })).toBe(false);
    // **規則を1本も書いていない表は、誰であっても越えない**(管轄外 = 既定のまま)。
    expect(
      roleReadCrossesOwnerScope({ manifest: base, roles: "owner", table: "work_member" }),
    ).toBe(false);
  });

  // **【消した検査。逐語を控える】**
  // **旧: `test("(B3) enabled: false の宣言は「宣言していない表」と同じ —— 今日どおり true", …)`。**
  // **`enabled: false` の表で `adminReadsAllRows` が `true` を返すことを測っていた。**
  // **`st_admin_readable` ごと廃止されたので測るものが無い**(`enabled: false` が
  //   「宣言していない表」と同じであること自体は (A3) が今日も測っている)。

  // **旧のテスト名: 「(B4) 宣言粒度を1ミリも動かしていない(行の値を1つも見ない。`ADR-0061` 限定3)」。**
  // **【誇張しない。粒度は動いた】** **旧 `adminReadsAllRows` は (表, ロール) の2引数で、
  //   行の値を1つも見なかった(`ADR-0061` 限定3)。** **今日の `roleReadCrossesOwnerScope` は
  //   `row` / `subject` を受け取り、条件(`when`)つきの規則が立っていれば行ごとに答えが変わる
  //   (`V8-M18` / `J-G12`)。** **したがって「1ミリも動かしていない」とは書けない** ——
  //   **動いたことをこの検査が記録する。**
  test("(B4) 判定の入口は1引数のオブジェクトで、行(`row`)と主体(`subject`)を受け取る(粒度は表単位ではない)", () => {
    expect(roleReadCrossesOwnerScope.length).toBe(1);
    const signature = /export function roleReadCrossesOwnerScope\(params: \{([\s\S]*?)\n\}\)/.exec(
      OWNER_SCOPE_SOURCE,
    );
    expect(signature).not.toBeNull();
    const keys = ((signature as RegExpExecArray)[1] ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => (line.split(":")[0] ?? "").trim().replace(/\?$/, ""));
    expect(keys).toEqual(["manifest", "roles", "table", "row", "subject"]);
  });

  // **旧のテスト名: 「(B5) `st_admin_readable` の綴りは `owner-scope.ts` 以外の製品コードに
  //   現れない(限定3の検査を赤くしない)」。**
  // **今日は `owner-scope.ts` を除外する必要が無い** —— **廃止したので、そこにも実行コードは
  //   1行も無い。** **除外を外したぶん、この検査は着手前より広い。**
  // **【誇張しない。コメントは除いて数えている】** **`st_admin_readable` の綴りは
  //   `src/server/app.ts` と `src/server/owner-scope.ts` の**コメント**に今日も残っている** ——
  //   **このリポジトリは「旧文を1バイトも消さない」作法を採っているためであり、書き漏らしでは
  //   ない。** **したがって本検査はコメントを落としてから数える** ——
  //   **測っているのは「判定に使われていないこと」であって「文字が消えたこと」ではない。**
  test("(B5) `st_admin_readable` の綴りは `src/server/` の実行コードに1件も残っていない(廃止の裏取り)", () => {
    const stripComments = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    const dir = new URL("./", import.meta.url).pathname;
    const offenders = readdirSync(dir).filter((name) => {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) {
        return false;
      }
      return stripComments(readFileSync(join(dir, name), "utf8")).includes("st_admin_readable");
    });
    expect(offenders).toEqual([]);
  });

  test("(B6) `_auth_users.role` は1ユーザ1ロールのまま(`ADR-0015` §1 を引き直さない)", () => {
    // **ロールの列は1本のままである** —— 複数ロール・ロールの配列を1つも作っていない。
    const store = readFileSync(new URL("../auth/store.ts", import.meta.url).pathname, "utf8");
    expect(store).toContain('export const ROLE_COLUMN_DDL = `"role" TEXT NOT NULL');
    expect(store).toContain(
      'const AUTH_USERS_COLUMN_NAMES = `"id","username","display_name","role","created_at"`',
    );
    expect(store.includes('"roles"')).toBe(false);
    // **本タスクは `src/auth/` を1バイトも触っていない**(検査で読むだけである)。
  });
});

// ---------------------------------------------------------------------------
// (D) 同居の拒否は `V7-M1-T05` が実装済みである(**本タスクが実装したのではない**)
// ---------------------------------------------------------------------------

// **【`V8-M20` / 台帳 `J-G30` / `ADR-0301`】拒否の通り数は 2 → 1 に減った。**
// **`st_admin_readable` を廃止した結果、`ACCESS_CONTROL_EXCLUSIVE_FIELDS` は
//   `["st_admin_readable", "st_public"]` → `["st_public"]` になった**
//   (`src/kernel/referential-integrity.ts` の逐語)。
// **旧の describe 名: 「V7-M2-T03 (D): st_admin_readable / st_public との同居は適用時に
//   拒否される(V7-M1-T05 の実装)」。**
describe("V7-M2-T03 (D): st_public との同居は適用時に拒否される(V7-M1-T05 の実装)", () => {
  function candidate(fields: unknown[], accessControl?: unknown): Manifest {
    return {
      app: {
        id: "co",
        name: "同居",
        tables: [
          tableWith(fields, accessControl),
          {
            id: "work_grant",
            name: "付与",
            fields: [
              { id: "work", name: "対象", type: "reference", reference_table: "t" },
              { id: "member", name: "相手", type: "reference", reference_table: "work_member" },
              { id: "permission", name: "権限", type: "select", options: ["reader", "writer"] },
            ],
          },
          {
            id: "work_member",
            name: "利用者",
            fields: [{ id: "account", name: "ログイン", type: "text" }],
          },
        ],
        views: [],
      },
    } as unknown as Manifest;
  }

  /** 拒否の文面を取り出す(**通ってしまったら検査を落とす**)。 */
  function rejection(input: Manifest, purpose: "incoming" | "stored"): string {
    const result = validateManifestFull(input, purpose);
    expect(result.valid).toBe(false);
    if (result.valid) {
      throw new Error("拒否されなかった");
    }
    return result.errors.map((error) => error.message).join("\n");
  }

  test("(D1) 宣言だけなら通る(対照)", () => {
    for (const purpose of ["incoming", "stored"] as const) {
      expect(
        validateManifestFull(candidate([TITLE_FIELD], { ...ACCESS_CONTROL }), purpose),
      ).toEqual({
        valid: true,
      });
    }
  });

  // **【置き直した検査】**
  // **旧: `test("(D2) st_admin_readable と同時に宣言した差分は拒否される(完了条件 (iii))", …)`。**
  // **`st_admin_readable` を廃止したので、その同居の拒否は製品コードから検査ごと消えた。**
  // **「拒否される」を測ることはもうできない** —— **代わりに、**拒否が消えたこと**を測る。**
  // **【誇張しない】** **これは失われたものの記録である。** **`st_admin_readable` という名前の
  //   項目は、今日はただの boolean 項目として通る**(`ADR-0301` の廃止が受け入れた代償)。
  test("(D2) `st_admin_readable` という名前の項目は、今日はただの項目として通る(同居の拒否は消えた)", () => {
    for (const purpose of ["incoming", "stored"] as const) {
      expect(
        validateManifestFull(
          candidate([TITLE_FIELD, { id: "st_admin_readable", name: "運営可視", type: "boolean" }], {
            ...ACCESS_CONTROL,
          }),
          purpose,
        ),
      ).toEqual({ valid: true });
    }
  });

  test("(D3) st_public との同居も同じ扱いである(別扱いにしていない)", () => {
    for (const purpose of ["incoming", "stored"] as const) {
      expect(
        rejection(candidate([TITLE_FIELD, PUBLIC_SCOPE_FIELD], { ...ACCESS_CONTROL }), purpose),
      ).toContain(PUBLIC_FIELD);
    }
  });

  // **【`V8-M20` / `J-G30`】測る項目を `st_admin_readable` から `st_public` へ置き直した。**
  // **旧: `candidate([TITLE_FIELD, ADMIN_FIELD], { ...ACCESS_CONTROL, enabled: false })`。**
  // **今日 `enabled: false` 限定であることを言えるのは、残った1本(`st_public`)だけである。**
  test("(D4) enabled: false なら同居は拒否されない(項目8 は enabled: true 限定である)", () => {
    for (const purpose of ["incoming", "stored"] as const) {
      expect(
        validateManifestFull(
          candidate([TITLE_FIELD, PUBLIC_SCOPE_FIELD], { ...ACCESS_CONTROL, enabled: false }),
          purpose,
        ),
      ).toEqual({ valid: true });
    }
  });

  // **【`V8-M20` / `J-G30`】旧はここで `ADMIN_READABLE_FIELD` の綴りも要求していた。**
  // **旧: `expect(source).toContain(ADMIN_READABLE_FIELD);`。**
  // **廃止した綴りを製品コードに要求し続けることはできないので、1行落とした。**
  test("(D5) 拒否しているのは `src/kernel/referential-integrity.ts` である(本タスクの実装ではない)", () => {
    const source = readFileSync(
      new URL("../kernel/referential-integrity.ts", import.meta.url).pathname,
      "utf8",
    );
    expect(source).toContain(PUBLIC_FIELD);
  });
});

// ---------------------------------------------------------------------------
// (E) 種類ごとに1バイトも分岐しない(`ADR-0158` 限定2 / `Z-G13` 限定4)
// ---------------------------------------------------------------------------

describe("V7-M2-T03 (E): judgeRecordAccess は種類ごとに1バイトも分岐していない", () => {
  const base = manifest();
  const row = { _id: "row-1", title: "案件" };
  const memberRows = [{ _id: "m-a", account: "user-a" }];
  const grantRows = [{ _id: "g-1", work: "row-1", member: "m-a", permission: "writer" }];

  test("(E1) 入力にロールも種類も1つも無い(署名で固定する)", () => {
    // **`judgeRecordAccess` の引数は1つのオブジェクトで、そのキーは6本ちょうどである。**
    const signature = /export function judgeRecordAccess\(params: \{([\s\S]*?)\n\}\)/.exec(
      OWNER_SCOPE_SOURCE,
    );
    expect(signature).not.toBeNull();
    const keys = ((signature as RegExpExecArray)[1] ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => (line.split(":")[0] ?? "").trim());
    expect(keys).toEqual(["manifest", "tableId", "row", "actorId", "grantRows", "memberRows"]);
    expect(keys.some((key) => /role|kind|customer|owner/i.test(key))).toBe(false);
  });

  test("(E2) 本体にロール・種類の綴りが1文字も無い(論証を検査に落とす)", () => {
    const start = OWNER_SCOPE_SOURCE.indexOf("export function judgeRecordAccess(params: {");
    expect(start).toBeGreaterThan(-1);
    const body = OWNER_SCOPE_SOURCE.slice(start, OWNER_SCOPE_SOURCE.indexOf("\n}", start));
    for (const spelling of ["role", "Role", "customer", "user_kind", "isReservedRole", "owner"]) {
      expect(body.includes(spelling)).toBe(false);
    }
  });

  test("(E3) 同じ付与・同じ actor なら、どのロール・どの種類でも答えは1バイトも変わらない", () => {
    // **判定はロールを受け取らないので、そもそも変わりようが無い** ——
    // **その「変わりようが無い」を、同じ入力を6通りの文脈で通して固定する。**
    const verdict = judgeRecordAccess({
      manifest: base,
      tableId: "works",
      row,
      actorId: "user-a",
      grantRows,
      memberRows,
    });
    expect(verdict).toEqual({ read: true, write: true, delete: false });
    for (const _role of ["owner", "editor", "viewer", "customer", "patient", "supplier"]) {
      expect(
        judgeRecordAccess({
          manifest: base,
          tableId: "works",
          row,
          actorId: "user-a",
          grantRows,
          memberRows,
        }),
      ).toEqual(verdict);
    }
  });
});

// ---------------------------------------------------------------------------
// (C) / (F) HTTP —— 運営ロールと、宣言された種類を含む6つの相手で実測する
// ---------------------------------------------------------------------------

const ACTOR_ROLES = ["owner", "editor", "viewer", "customer", "patient", "supplier"] as const;
type ActorRole = (typeof ACTOR_ROLES)[number];

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;
let actors: Record<ActorRole, ReturnType<typeof seedSession>>;
let members: Record<ActorRole, string>;
/** 付与のある行 / 付与の無い行 / 宣言していない表の行 / 台帳の他人の行。 */
let openRow = "";
let closedRow = "";
let plainRow = "";
let ledgerRow = "";

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

function grantTo(memberId: string, recordId: string, permission: string): void {
  const loaded = manifest();
  withDb((db) => {
    const created = createRecord(db, loaded, "work_grant", {
      work: recordId,
      member: memberId,
      permission,
    });
    expect(created.ok).toBe(true);
  });
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-acrp-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "工房", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, manifestWithRoles()).valid).toBe(true);
  app = createServerApp({ dataRoot });

  actors = {} as Record<ActorRole, ReturnType<typeof seedSession>>;
  for (const role of ACTOR_ROLES) {
    actors[role] = seedSession(dataRoot, APP_ID, { role, username: `u-${role}` });
  }

  const loaded = manifest();
  members = {} as Record<ActorRole, string>;
  withDb((db) => {
    const work = (title: string): string => {
      const created = createRecord(db, loaded, "works", {
        title,
        secret: "内部だけ",
        locked: "確定",
      });
      expect(created.ok).toBe(true);
      return (created as { value: { _id: string } }).value._id;
    };
    openRow = work("付与のある案件");
    closedRow = work("付与の無い案件");

    const plain = createRecord(db, loaded, "plain", { body: "宣言していない表" });
    expect(plain.ok).toBe(true);
    plainRow = (plain as { value: { _id: string } }).value._id;

    // **台帳は他人(`someone-else`)の行である** —— `owner` が今日どおり読めることの対照。
    const ledger = createRecord(db, loaded, "ledger", {
      memo: "他人の行",
      [OWNER_FIELD]: "someone-else",
    });
    expect(ledger.ok).toBe(true);
    ledgerRow = (ledger as { value: { _id: string } }).value._id;

    // **6人ともメンバー表に行を持つ** —— **「付与が無い」と「メンバー行が無い」を分けるため。**
    for (const role of ACTOR_ROLES) {
      const created = createRecord(db, loaded, "work_member", { account: actors[role].userId });
      expect(created.ok).toBe(true);
      members[role] = (created as { value: { _id: string } }).value._id;
    }
  });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

describe("V7-M2-T03 (C): 運営ロール(owner)が、付与の無い行を API から取れない", () => {
  test("(C1) 付与が1件も無い owner には、一覧 GET が1件も返さない", async () => {
    const response = await get(`/api/apps/${APP_ID}/tables/works/records`, actors.owner.cookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { records: { _id: string }[]; total: number };
    expect(body.records).toEqual([]);
    expect(body.total).toBe(0);
  });

  test("(C2) 付与の無い行の単件 GET は owner でも 404(存在を伏せる)", async () => {
    const response = await get(
      `/api/apps/${APP_ID}/tables/works/records/${closedRow}`,
      actors.owner.cookie,
    );
    expect(response.status).toBe(404);
  });

  test("(C3) 付与の無い行の PATCH は owner でも 404", async () => {
    const response = await patch(
      `/api/apps/${APP_ID}/tables/works/records/${closedRow}`,
      actors.owner.cookie,
      "2026-01-01T00:00:00.000Z",
      { title: "書き換えたい" },
    );
    expect(response.status).toBe(404);
  });

  test("(C4) 付与を1件入れたら owner に見えるようになる(拒否側だけを測らない)", async () => {
    grantTo(members.owner, openRow, "writer");
    const list = await get(`/api/apps/${APP_ID}/tables/works/records`, actors.owner.cookie);
    const body = (await list.json()) as { records: { _id: string }[]; total: number };
    expect(body.records.map((record) => record._id)).toEqual([openRow]);
    expect(body.total).toBe(1);

    const single = await get(
      `/api/apps/${APP_ID}/tables/works/records/${openRow}`,
      actors.owner.cookie,
    );
    expect(single.status).toBe(200);
    const version = single.headers.get("etag") ?? "";
    expect(version).not.toBe("");

    const updated = await patch(
      `/api/apps/${APP_ID}/tables/works/records/${openRow}`,
      actors.owner.cookie,
      version,
      { title: "書き換えた" },
    );
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as { record: { title: string } }).record.title).toBe(
      "書き換えた",
    );

    // **付与の無い行は、付与を1件入れたあとも見えないままである。**
    expect(
      (await get(`/api/apps/${APP_ID}/tables/works/records/${closedRow}`, actors.owner.cookie))
        .status,
    ).toBe(404);
  });

  test("(C5) read だけの付与では owner でも PATCH が 403(運営ロールが権限名を迂回しない)", async () => {
    grantTo(members.owner, openRow, "reader");
    const single = await get(
      `/api/apps/${APP_ID}/tables/works/records/${openRow}`,
      actors.owner.cookie,
    );
    expect(single.status).toBe(200);
    const response = await patch(
      `/api/apps/${APP_ID}/tables/works/records/${openRow}`,
      actors.owner.cookie,
      single.headers.get("etag") ?? "",
      { title: "書き換えたい" },
    );
    expect(response.status).toBe(403);
  });

  test("(C6) 宣言していない表では owner が今日どおり全行を見られる(オプトインの側)", async () => {
    const response = await get(`/api/apps/${APP_ID}/tables/plain/records`, actors.owner.cookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { records: { _id: string }[]; total: number };
    expect(body.records.map((record) => record._id)).toEqual([plainRow]);
    expect(body.total).toBe(1);
  });

  // **【`V8-M20` / `J-G30` / `ADR-0301` / `D-V8-35`】置き直した検査。**
  // **旧のテスト名: 「(C7) `st_admin_readable` だけを宣言した表では owner が今日どおり
  //   他人の行を読める」。**
  // **旧は `ledger` に `st_admin_readable` を1本立てて、`owner` にだけ他人の行を見せていた。**
  // **今日は面の規則 `{target:"table", table:"ledger", can:["read"]}` を `owner` に書く。**
  // **【誇張しない。`editor` の落ち方が変わった】** **旧の `editor` は「読めるが自分の行だけ」
  //   だったので空の一覧が返っていた。** **今日の `editor` は面の allow-list に入っていない
  //   ので、面が止める側に落ちる** —— **結果として1件も見えないことは変わらないが、
  //   止めている層は違う。**
  test("(C7) 面の規則で読取を開いた表では owner が他人の行を読める(`editor` は1件も見られない)", async () => {
    const response = await get(`/api/apps/${APP_ID}/tables/ledger/records`, actors.owner.cookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { records: { _id: string }[] };
    expect(body.records.map((record) => record._id)).toEqual([ledgerRow]);
    // **`editor` は他人の行を1件も見られない**(面の allow-list に入っていない)。
    const asEditor = await get(`/api/apps/${APP_ID}/tables/ledger/records`, actors.editor.cookie);
    expect(((await asEditor.json()) as { records?: unknown[] }).records ?? []).toEqual([]);
  });
});

describe("V7-M2-T03 (E-HTTP): 運営3ロールも宣言された種類も、まったく同じ判定を受ける", () => {
  test("(E4) 付与が無ければ6つの相手すべてに1件も返らない", async () => {
    for (const role of ACTOR_ROLES) {
      const response = await get(`/api/apps/${APP_ID}/tables/works/records`, actors[role].cookie);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { records: unknown[]; total: number };
      expect({ role, records: body.records, total: body.total }).toEqual({
        role,
        records: [],
        total: 0,
      });
    }
  });

  test("(E5) 同じ付与を入れれば6つの相手すべてに同じ行が返る", async () => {
    for (const role of ACTOR_ROLES) {
      grantTo(members[role], openRow, "writer");
    }
    for (const role of ACTOR_ROLES) {
      const response = await get(`/api/apps/${APP_ID}/tables/works/records`, actors[role].cookie);
      const body = (await response.json()) as { records: { _id: string }[]; total: number };
      expect({ role, ids: body.records.map((record) => record._id), total: body.total }).toEqual({
        role,
        ids: [openRow],
        total: 1,
      });
      // **付与の無い行は、どの相手にも1度も現れない。**
      expect(body.records.some((record) => record._id === closedRow)).toBe(false);
    }
  });

  test("(E6) 単件 GET も、6つの相手すべてで同じ応答コードになる", async () => {
    for (const role of ACTOR_ROLES) {
      grantTo(members[role], openRow, "writer");
    }
    for (const role of ACTOR_ROLES) {
      const open = await get(
        `/api/apps/${APP_ID}/tables/works/records/${openRow}`,
        actors[role].cookie,
      );
      const closed = await get(
        `/api/apps/${APP_ID}/tables/works/records/${closedRow}`,
        actors[role].cookie,
      );
      expect({ role, open: open.status, closed: closed.status }).toEqual({
        role,
        open: 200,
        closed: 404,
      });
    }
  });

  test("(E7) PATCH も、6つの相手すべてで同じ応答コードになる", async () => {
    // **`viewer` はここに入らない** —— **`viewer` の書込は `V1-M3-T02` のロール規律が
    // 中継層で 403 にしており、行の付与の判定まで届かない。** **本タスクはその規律を
    // 1バイトも動かしていない。**
    //
    // --- 【`V8-M27-T04` / `T-G5`。期待値を反転させた。旧のテスト名と旧の期待値を残す】 ---
    //
    // **旧のテスト名**: `(E7) PATCH も、書込を許された5つの相手すべてで同じ応答コードになる`
    // **旧の期待値(逐語)**: `closed: role === "viewer" ? 403 : 404,`
    // **上の3行の説明も旧のものである。1バイトも消していない。**
    //
    // **根拠**: **`V8-M27` / 台帳 `T-G5` / ユーザ決定 `D-V8-38`。**
    // **`viewer` を中継層で止めていた `hasAdminWriteRole` を撤去した** ——
    // **`viewer` の書込も、今日は行の付与の判定まで届く。**
    // **したがって「5つの相手」は「6つの相手」になり、`viewer` の例外が消えた** ——
    // **この describe の主題(「まったく同じ判定を受ける」)が、`viewer` にも及んだ形である。**
    for (const role of ACTOR_ROLES) {
      grantTo(members[role], openRow, "writer");
    }
    for (const role of ACTOR_ROLES) {
      const single = await get(
        `/api/apps/${APP_ID}/tables/works/records/${openRow}`,
        actors[role].cookie,
      );
      const version = single.headers.get("etag") ?? "";
      const closed = await patch(
        `/api/apps/${APP_ID}/tables/works/records/${closedRow}`,
        actors[role].cookie,
        version,
        { title: `${role} が書き換えたい` },
      );
      expect({ role, closed: closed.status }).toEqual({ role, closed: 404 });
    }
  });
});

// **【`V8-M20` / 台帳 `J-G28` / `ADR-0301`】(F) 群は綴りだけを置き直した。**
// **旧: 項目の宣言 `field.audience`(見せる相手)/ `field.writable_by`(書ける相手)。**
// **新: 面の規則 `{target:"field", table, field, can:["read"] / ["read","write"]}`。**
// **測る形(行の権限が項目の判定を1バイトも上書きしない = AND)は1ミリも変えていない。**
describe("V7-M2-T03 (F): 項目単位の判定との重ね順は AND(運営ロールについても)", () => {
  // **旧のテスト名: 「(F1) audience で隠した項目は、付与を持つ owner にも見えない
  //   (行の権限が上書きしない)」。**
  test("(F1) 面の規則で隠した項目は、付与を持つ owner にも見えない(行の権限が上書きしない)", async () => {
    grantTo(members.owner, openRow, "writer");
    const response = await get(
      `/api/apps/${APP_ID}/tables/works/records/${openRow}`,
      actors.owner.cookie,
    );
    expect(response.status).toBe(200);
    const record = ((await response.json()) as { record: Record<string, unknown> }).record;
    expect(Object.hasOwn(record, "title")).toBe(true);
    // **`secret` の読取を `editor` にしか書いていないので、owner には出ない。**
    // **旧: `audience: ["editor"]` なので owner には出ない。**
    expect(Object.hasOwn(record, "secret")).toBe(false);
  });

  // **旧のテスト名: 「(F2) audience を満たす editor には、付与があれば見える(AND の両側を測る)」。**
  test("(F2) 面の規則を満たす editor には、付与があれば見える(AND の両側を測る)", async () => {
    grantTo(members.editor, openRow, "writer");
    const response = await get(
      `/api/apps/${APP_ID}/tables/works/records/${openRow}`,
      actors.editor.cookie,
    );
    const record = ((await response.json()) as { record: Record<string, unknown> }).record;
    expect(record.secret).toBe("内部だけ");
  });

  // **旧のテスト名: 「(F3) writable_by で止めた項目は、write を持つ owner にも書けない(403)」。**
  test("(F3) 面の規則で止めた項目は、write を持つ owner にも書けない(403)", async () => {
    grantTo(members.owner, openRow, "writer");
    const single = await get(
      `/api/apps/${APP_ID}/tables/works/records/${openRow}`,
      actors.owner.cookie,
    );
    const version = single.headers.get("etag") ?? "";
    // **同じ行・同じ版で、宣言の無い項目は通る。**
    const allowed = await patch(
      `/api/apps/${APP_ID}/tables/works/records/${openRow}`,
      actors.owner.cookie,
      version,
      { title: "題は書ける" },
    );
    expect(allowed.status).toBe(200);
    const next = allowed.headers.get("etag") ?? "";
    // **書込を `editor` にしか書いていない項目は、write の付与を持つ owner でも 403。**
    // **旧: `writable_by: ["editor"]` の項目は、write の付与を持つ owner でも 403。**
    const denied = await patch(
      `/api/apps/${APP_ID}/tables/works/records/${openRow}`,
      actors.owner.cookie,
      next,
      { locked: "書き換えたい" },
    );
    expect(denied.status).toBe(403);
  });

  // **旧のテスト名: 「(F4) 付与が無ければ、audience を満たす editor でも1件も見えない
  //   (AND のもう一方)」。**
  test("(F4) 付与が無ければ、面の規則を満たす editor でも1件も見えない(AND のもう一方)", async () => {
    const response = await get(
      `/api/apps/${APP_ID}/tables/works/records/${openRow}`,
      actors.editor.cookie,
    );
    expect(response.status).toBe(404);
  });
});
