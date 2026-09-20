/**
 * **`V18-M2-T03`(TDD の赤)**: **条件を1つも持たない役割の規則の「読取」だけを根拠にした
 * 読取を、行ごとの付与(点)が管轄内の表では通さない。**
 *
 * ## この1本が撃つ契約(`04-v18-m2-plan.md` §5-2 + §12-2 の置き換え)
 *
 * | # | 直った後に真であること | 本ファイルの担当 |
 * |--:|---|---|
 * | **1** | **条件なしの読取だけを根拠にした読取は、点が管轄内の表では通らない** | **§(C1)** |
 * | **2** | **ただし役割が運営者(`owner`)の人は今日どおり通る**(`D-V18-18`) | **§(C2)** |
 * | **3** | **点(行ごとの付与)を持つ人は今日どおり読める** | **§(C3)** |
 * | **4** | **条件つきの規則の読取は今日どおり効く**(巻き添えにしない) | **§(C4)** |
 * | **5** | **点が管轄外の表は1ビットも答えが変わらない** | **§(C5)** |
 * | **6** | **書込・削除の答えは1ビットも変わらない**(`D-V18-17`) | **§(C6)** |
 * | 7 | 持ち主で絞る表(`owner_scoped`)の答えが変わらない | 配る版の同名の検査ファイル |
 * | 8 | 本体と配る版の答えが1ビットも違わない | 同上 |
 *
 * **契約7 は `owner-scope.ts` の合成の層に住んでいない**(`st_owner` の絞りは
 * サーバ層の後絞りと、生成器の `populationPredicate` の `owner_scoped` 分岐である)。
 * **したがって本ファイルは契約7 を1件も撃っていない。** **隠さない。**
 *
 * ## 【この時点で赤い】—— **それが本葉の成果物である**
 *
 * **`V18-M2-T03` は「必ず落ちる検査を書く」ところまでの葉であり、製品コードを
 * 1バイトも書き換えていない。** **赤いのは §(C1) の3本だけのはずである**
 * (§(C0) と §(C2)〜§(C6) は退行の担保であり、今日すでに緑である)。
 *
 * ## 【禁止】期待値に「今日の壊れた答え」を書かない
 *
 * **§(C1) が書いているのは**直った後の答え**である。** **今日の製品はここで `true` を返す。**
 *
 * ## 通る道(**完了条件 (c) の名指し**)
 *
 * - **`combineRoleAndGrantAccess`**(`src/server/owner-scope.ts:5231`)——
 *   **§(C1-b) / §(C4-c) / §(C5-b) / §(C6-d) が直に呼ぶ。** **§(C1-a) / §(C1-c) / §(C2)〜§(C6) は
 *   `resolveCombinedRecordAccess`(`:5354`)の `:5382`-`:5384` を通って同じ関数に入る。**
 * - **`combineFaceAndPoint`**(配る版の `src/predicates.ts:1685`)は
 *   **本ファイルからは通らない** —— **生成器側の検査ファイルが
 *   `populationPredicate`(`:1722`。export)の `record_access` 分岐を通して撃つ。**
 *
 * ## 【正直に書く】本ファイルが測っていないもの
 *
 * 1. **HTTP の口を1本も通っていない。** **画面も AI の口も自動処理も1度も叩いていない。**
 * 2. **実地データを1バイトも読んでいない。** **サーバを1つも起こしていない。**
 * 3. **配る版(生成器)の答えを1件も測っていない。**
 * 4. **`D-V18-18` の例外を実装にどう届けるかを1つも決めていない**
 *    —— **決めるのは `V18-M2-T04` である**(`ADR-0437` §限界3)。
 *    **本ファイルが書いたのは「運営者の答えは変わらない」という**外から見た形**だけである。**
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Manifest } from "../kernel/index.ts";
import {
  combineRoleAndGrantAccess,
  judgeRoleAccess,
  type RecordAccessSourceTables,
  resolveCombinedRecordAccess,
} from "./owner-scope.ts";

// =====================================================================================
// 0. 題材(**このファイルの中のオブジェクトリテラル1本。他の検査の題材を1バイトも触らない**)
// =====================================================================================

/** 権限名2つ(**符号(`restrictive`)を1本も持たない** —— 上限はこの葉の相手ではない)。 */
const PERMISSIONS = [
  { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
  { id: "keeper", name: "消せる", read: true, write: true, delete: true },
] as const;

/**
 * 題材のアプリ定義。
 *
 * - **`books`** —— **点(`access_control`)を宣言する表。** **`owner` と `editor` が
 *   **条件を1つも持たない**規則を持ち、`viewer` だけが `when` つきの規則を持つ。**
 * - **`notes`** —— **点を1件も宣言しない表**(契約5 の相手)。
 */
function manifest(): Manifest {
  return {
    app: {
      id: "v18-m2-t03",
      name: "面と点の合成(赤を書くための題材)",
      roles: [
        {
          id: "owner",
          name: "運営",
          rules: [
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
            // **条件を1つも持たない**(`D-V18-18` の相手)。
            { target: "table", table: "books", can: ["read", "write", "delete"] },
            { target: "table", table: "notes", can: ["read"] },
          ],
        },
        {
          id: "editor",
          name: "編集",
          rules: [
            // **条件を1つも持たない読取**(V18-M2 が塞ぐ相手そのもの)。
            { target: "table", table: "books", can: ["read", "write"] },
            { target: "table", table: "notes", can: ["read"] },
          ],
        },
        {
          id: "viewer",
          name: "閲覧",
          rules: [
            // **条件つき**(巻き添えにしてはならない相手)。
            {
              target: "table",
              table: "books",
              can: ["read"],
              when: { field: "status", equals: "公開" },
            },
          ],
        },
      ],
      tables: [
        {
          id: "books",
          name: "書籍",
          fields: [
            { id: "title", name: "タイトル", type: "text", required: true },
            { id: "status", name: "状態", type: "text" },
          ],
          access_control: {
            enabled: true,
            permissions: PERMISSIONS.map((one) => ({ ...one })),
            creator_permission: "keeper",
            grant: {
              table: "book_grant",
              target: "book",
              member: "member",
              permission: "permission",
            },
            members: { table: "book_member", account: "account" },
          },
        },
        { id: "notes", name: "覚書", fields: [{ id: "title", name: "タイトル", type: "text" }] },
        {
          id: "book_member",
          name: "利用者",
          fields: [{ id: "account", name: "ログイン", type: "text" }],
        },
        {
          id: "book_grant",
          name: "付与",
          fields: [
            { id: "book", name: "本", type: "reference", reference_table: "books" },
            { id: "member", name: "相手", type: "reference", reference_table: "book_member" },
            {
              id: "permission",
              name: "権限",
              type: "select",
              options: PERMISSIONS.map((one) => one.id),
            },
          ],
        },
      ],
      views: [],
    },
  } as unknown as Manifest;
}

/** 利用者表の行(**`user-a` だけが名簿に居る**)。 */
const MEMBER_ROWS = [{ _id: "m-a", account: "user-a" }] as const;

/** 非公開の行(**`viewer` の条件が当たらない**)。 */
const ROW_PRIVATE = { _id: "row-1", title: "吾輩は猫である", status: "非公開" } as const;

/** 公開の行(**`viewer` の条件が当たる**)。 */
const ROW_PUBLIC = { _id: "row-2", title: "坊っちゃん", status: "公開" } as const;

/** 点の出所(**`books` の宣言と揃えてある**)。 */
// 旧文(V18-M2-T03 時点): const SOURCES = { grantTable: "book_grant", memberTable: "book_member" } as const;
// **`books` は `groups` を宣言していない**(`:124`-`:135` の `access_control`)ので
// `recordAccessSourceTables` は `groupTable: undefined` を返す(`owner-scope.ts:958`-`:963`)。
// **`RecordAccessSourceTables` は3つ目の鍵を必須にしている**ので、ここでも明示する
// (`askD` の `:510` が既にこの形を採っている。答えは1ビットも変わらない)。
const SOURCES = {
  grantTable: "book_grant",
  memberTable: "book_member",
  groupTable: undefined,
} as const;

/**
 * **合成の本線を1回叩く**(`resolveCombinedRecordAccess:5354` →
 * `combineRoleAndGrantAccess:5382`-`:5384`)。
 */
function ask(params: {
  roles: readonly string[];
  grantRows?: readonly Record<string, unknown>[];
  row?: Record<string, unknown>;
  tableId?: string;
  /** **`undefined` を渡すと「点が管轄外」になる**(契約5)。 */
  // 旧文(V18-M2-T03 時点、型が owner-scope.ts の RecordAccessSourceTables と揃っていなかった):
  //   sources?: { grantTable: string; memberTable: string } | undefined;
  sources?: RecordAccessSourceTables | undefined;
}): { read: boolean; write: boolean; delete: boolean } {
  const rows: Record<string, readonly Record<string, unknown>[]> = {
    book_grant: params.grantRows ?? [],
    book_member: [...MEMBER_ROWS],
  };
  const resolution = resolveCombinedRecordAccess({
    manifest: manifest(),
    tableId: params.tableId ?? "books",
    row: params.row ?? { ...ROW_PRIVATE },
    actorId: "user-a",
    roles: [...params.roles],
    sources: "sources" in params ? params.sources : { ...SOURCES },
    readRows: (tableId: string) => rows[tableId] ?? [],
    readRow: (tableId: string, recordId: string) =>
      (rows[tableId] ?? []).find((one) => one._id === recordId),
  });
  if (resolution.kind !== "verdict") {
    throw new Error("この題材は辿りの上限に当たらない(符号つきの付与も鎖も持たない)");
  }
  return resolution.verdict;
}

// =====================================================================================
// (C0) 前提 —— **題材が本当に「条件なしの読取」と「点が管轄内」を持っている**
// =====================================================================================

describe("V18-M2-T03 (C0): 題材の前提(**赤の理由を題材の側に取り違えない**)", () => {
  test("(C0-1) `editor` の `books` 読取は、条件を1つも持たない(`conditional: false`)", () => {
    const decision = judgeRoleAccess({
      manifest: manifest(),
      roles: ["editor"],
      target: { target: "table", table: "books" },
      verb: "read",
      row: { ...ROW_PRIVATE },
      subject: "user-a",
    });
    // **【2026-09-11 追記(`V18-M2-T10`)。旧の期待値を逐語で残す】**
    // **旧: `expect(decision).toEqual({ allowed: true, governed: true, blockedBy: null,`**
    // **旧: `  conditional: false, });`**
    // **`ADR-0438` 行11 が `RoleAccessDecision` に旗を1つ足したので、条件なしの規則で
    // 許可が出た判定には `unconditionalAllow: true` が載る。** **答えは1ビットも
    // 変わっていない**(`allowed` / `governed` / `blockedBy` / `conditional` は同じ)。
    expect(decision).toEqual({
      allowed: true,
      governed: true,
      blockedBy: null,
      conditional: false,
      unconditionalAllow: true,
    });
  });

  test("(C0-2) `viewer` の `books` 読取は、条件つきである(`conditional: true`)", () => {
    const decision = judgeRoleAccess({
      manifest: manifest(),
      roles: ["viewer"],
      target: { target: "table", table: "books" },
      verb: "read",
      row: { ...ROW_PUBLIC },
      subject: "user-a",
    });
    expect(decision).toEqual({ allowed: true, governed: true, blockedBy: null, conditional: true });
  });
});

// =====================================================================================
// (C1) 契約1 —— **条件なしの読取だけを根拠にした読取は通らない**(**今日は赤い**)
// =====================================================================================

describe("V18-M2-T03 (C1) 契約1: 条件なしの読取だけでは、点が管轄内の表を読めない", () => {
  test("(C1-a) `editor`(条件なしの読取だけ)は、付与を1件も持たない行を読めない", () => {
    // **直った後の答えを書いている。** **今日の製品はここで `read: true` を返す(= 赤)。**
    expect(ask({ roles: ["editor"] }).read).toBe(false);
  });

  test("(C1-b) `combineRoleAndGrantAccess` は、条件なしの面だけでは読取を通さない", () => {
    // **合成の関数(`owner-scope.ts:5231`)を直に叩く。**
    // **`conditional: false` = 「条件を1つも持たない規則だけが面を通した」の印である
    // (`RoleAccessDecision` は `:4636` で既にこの値を持っている)。**
    // **【2026-09-11 追記(`V18-M2-T10`)。旧の1行を逐語で残す】**
    // **旧: `      role: { allowed: true, governed: true, blockedBy: null, conditional: false },`**
    // **`ADR-0438` 行11 の後、狭めが見るのは `conditional` ではなく
    // `unconditionalAllow` である。** **条件なしの規則が許可を出した面は、この旗で表す。**
    const combined = combineRoleAndGrantAccess({
      role: {
        allowed: true,
        governed: true,
        blockedBy: null,
        conditional: false,
        unconditionalAllow: true,
      },
      grant: { read: false, write: false, delete: false },
      verb: "read",
    });
    // **直った後の答え。** **今日の製品は `true` を返す(= 赤)。**
    expect(combined.allowed).toBe(false);
  });

  test("(C1-c) 付与が**別の行**にしかない人も、その行は読めない(付与は行ごとである)", () => {
    // **今日は面が通してしまうので、点が行ごとであることが外から見えない(= 赤)。**
    expect(
      ask({
        roles: ["editor"],
        grantRows: [{ _id: "g-1", book: "row-2", member: "m-a", permission: "reader" }],
      }).read,
    ).toBe(false);
  });
});

// =====================================================================================
// (C2) 契約2 —— **運営者(`owner`)は今日どおり通る**(`D-V18-18`。**今日は緑。緑のまま**)
// =====================================================================================

describe("V18-M2-T03 (C2) 契約2: 運営者は今日どおり読める(`D-V18-18`)", () => {
  test("(C2-a) `owner` は、付与を1件も持たない行を今日どおり読める", () => {
    expect(ask({ roles: ["owner"] }).read).toBe(true);
  });

  test("(C2-b) `owner` と `editor` を両方持つ人も、運営者として読める", () => {
    // **`ActorRoles` は集合である**(`owner-scope.ts:506`)。
    // **運営者の例外は「集合に `owner` が入っているか」で決まる** ——
    // **`declaredMatchesRoles`(`:523`)が今日この形を3箇所で使っている
    // (`GRANT_WRITE_ADMIN_ROLES` `:3206` / `ROLE_ASSIGNMENT_ELEVATED_ROLES` `:3694` /
    // `ORPHAN_PARENT_RECOVERY_ROLES` `:3782`)。**
    expect(ask({ roles: ["editor", "owner"] }).read).toBe(true);
  });
});

// =====================================================================================
// (C3) 契約3 —— **点を持つ人は今日どおり読める**(**退行の担保。今日は緑**)
// =====================================================================================

describe("V18-M2-T03 (C3) 契約3: 行ごとの付与を持つ人は今日どおり読める", () => {
  test("(C3-a) `editor` でも、その行に付与が1件あれば読める", () => {
    expect(
      ask({
        roles: ["editor"],
        grantRows: [{ _id: "g-1", book: "row-1", member: "m-a", permission: "reader" }],
      }).read,
    ).toBe(true);
  });
});

// =====================================================================================
// (C4) 契約4 —— **条件つきの規則は巻き添えにしない**(**今日は緑**)
// =====================================================================================

describe("V18-M2-T03 (C4) 契約4: 条件つきの規則の読取は今日どおり効く", () => {
  test("(C4-a) 条件が当たる行は、付与が1件も無くても `viewer` が読める", () => {
    expect(ask({ roles: ["viewer"], row: { ...ROW_PUBLIC } }).read).toBe(true);
  });

  test("(C4-b) 条件が当たらない行は、今日どおり読めない", () => {
    expect(ask({ roles: ["viewer"], row: { ...ROW_PRIVATE } }).read).toBe(false);
  });

  test("(C4-c) `combineRoleAndGrantAccess` は、条件つきの面(`conditional: true`)を通す", () => {
    const combined = combineRoleAndGrantAccess({
      role: { allowed: true, governed: true, blockedBy: null, conditional: true },
      grant: { read: false, write: false, delete: false },
      verb: "read",
    });
    expect(combined.allowed).toBe(true);
  });
});

// =====================================================================================
// (C5) 契約5 —— **点が管轄外の表は1ビットも変わらない**(**今日は緑**)
// =====================================================================================

describe("V18-M2-T03 (C5) 契約5: 付与を1件も宣言していない表は1ビットも変わらない", () => {
  test("(C5-a) `notes`(点が管轄外)は、条件なしの読取だけで今日どおり読める", () => {
    expect(
      ask({
        roles: ["editor"],
        tableId: "notes",
        row: { _id: "n-1", title: "覚書" },
        sources: undefined,
      }),
    ).toEqual({ read: true, write: false, delete: false });
  });

  test("(C5-b) `combineRoleAndGrantAccess` は、点が管轄外(`grant: undefined`)なら面の答えをそのまま返す", () => {
    expect(
      combineRoleAndGrantAccess({
        role: { allowed: true, governed: true, blockedBy: null, conditional: false },
        grant: undefined,
        verb: "read",
      }).allowed,
    ).toBe(true);
  });
});

// =====================================================================================
// (C6) 契約6 —— **書込・削除は1ビットも変わらない**(`D-V18-17`。**今日は緑**)
// =====================================================================================

describe("V18-M2-T03 (C6) 契約6: 書込・削除の答えは1ビットも変わらない(`D-V18-17`)", () => {
  test("(C6-a) 条件なしの書込の規則は、点が止めていても今日どおり通る", () => {
    // **`(A-4)` と同じ形である** —— **面が許すので `OR` で通る。**
    // **`D-V18-17`(ユーザ決定)により、この穴は開けたまま残す。**
    expect(ask({ roles: ["editor"] }).write).toBe(true);
  });

  test("(C6-b) 付与が読取だけでも、面が許す書込は今日どおり通る", () => {
    expect(
      ask({
        roles: ["editor"],
        grantRows: [{ _id: "g-1", book: "row-1", member: "m-a", permission: "reader" }],
      }).write,
    ).toBe(true);
  });

  test("(C6-c) 削除は、面も点も許さないので今日どおり通らない", () => {
    expect(ask({ roles: ["editor"] }).delete).toBe(false);
  });

  test("(C6-d) `combineRoleAndGrantAccess` の書込・削除は、条件なしの面でも今日どおり通る", () => {
    const role = { allowed: true, governed: true, blockedBy: null, conditional: false } as const;
    const grant = { read: false, write: false, delete: false } as const;
    expect(combineRoleAndGrantAccess({ role, grant, verb: "write" }).allowed).toBe(true);
    expect(combineRoleAndGrantAccess({ role, grant, verb: "delete" }).allowed).toBe(true);
  });

  test("(C6-e) `(A-4)` の期待値が1バイトも書き換えられていない(`ADR-0437` 限定7)", async () => {
    // **`access-control-upper-bound.test.ts:251` の `(A-4)` を、逐語で押さえる。**
    // **`V18-M2` はこの検査の期待値を「ついでに直す」ことを禁じられている。**
    const body = await Bun.file(join(import.meta.dir, "access-control-upper-bound.test.ts")).text();
    expect(body).toContain(
      "(A-4) 群4: 面が全部許す + 上限 —— 面は OR なので通る(上限は面を絞らない)",
    );
    expect(body).toContain(
      "expect(resolution.verdict).toEqual({ read: true, write: true, delete: true });",
    );
  });
});

// =====================================================================================
// (D) 【2026-09-11 追記(`V18-M2-T10`。ユーザ決定 `D-V18-19` / `ADR-0438` 行11)。
//     上の §(C1)〜§(C6) を1バイトも書き換えていない】
//
// **`V18-M2-T09` が複製の上で撃って見つけた形を、ここで固定する** ——
// **役割の規則を `[条件なしの read]` から `[条件なしの read, 誰にも当たらない条件つきの read]`
// にしただけで、§(C1) の狭めが丸ごと外れる。**
//
// **理由**: **`judgeRoleAccess` の `conditional` は「その動詞に合致した規則」を**全部合算**して
// 立つので、**許可を1件も出さない規則**でも立つ。** **狭めが `!role.conditional` を条件に
// しているため、当たらない条件つきの規則を1本足すだけで外れる。**
//
// **直す向き**(`ADR-0438` §Decision 4): **「その動詞に条件つきの規則が在るか」ではなく、
// **「条件を1つも持たない規則によって許可が出たか」**(`unconditionalAllow`)で判定する。**
//
// | # | 形 | 期待 |
// |--:|---|---|
// | **(D1)** | 条件なしの read + **誰にも当たらない**条件つきの read | **配りが効く** |
// | **(D2)** | 条件なしの read + **実際に当たる**条件つきの read | **配りが効く** |
// | **(D3)** | **当たる条件つきの read だけ**(条件なしは1本も無い) | **今日どおり `OR`** |
// | **(D4)** | **運営者**に (D1) と同じ2本 | **今日どおり全部見える**(`D-V18-18`) |
// =====================================================================================

/** (D) の題材で使う、**誰にも当たらない**条件(行の `status` は `公開` か `非公開` である)。 */
const DECOY_NEVER = { field: "status", equals: "誰にも当たらない値" } as const;

/** (D) の題材で使う、**`ROW_PRIVATE` に当たる**条件。 */
const DECOY_ALWAYS = { field: "status", equals: "非公開" } as const;

/**
 * (D) の題材。**`manifest()` を1バイトも触らず、別のオブジェクトリテラルを1本立てる。**
 *
 * @param decoy **`editor` の `books` 読取に足す条件つきの規則。`undefined` なら足さない。**
 * @param ownerDecoy **`owner` の `books` 読取に足す条件つきの規則**(§(D4) 用)。
 */
function manifestD(params: {
  decoy?: Record<string, unknown> | undefined;
  ownerDecoy?: Record<string, unknown> | undefined;
}): Manifest {
  const base = manifest() as unknown as { app: Record<string, unknown> };
  const roles: Record<string, unknown>[] = (base.app.roles as Record<string, unknown>[]).map(
    (role) => ({
      ...role,
      rules: [...(role.rules as Record<string, unknown>[])],
    }),
  );
  const editor = roles.find((role) => role.id === "editor");
  if (editor !== undefined && params.decoy !== undefined) {
    (editor.rules as Record<string, unknown>[]).push({
      target: "table",
      table: "books",
      can: ["read"],
      when: { ...params.decoy },
    });
  }
  const owner = roles.find((role) => role.id === "owner");
  if (owner !== undefined && params.ownerDecoy !== undefined) {
    (owner.rules as Record<string, unknown>[]).push({
      target: "table",
      table: "books",
      can: ["read"],
      when: { ...params.ownerDecoy },
    });
  }
  return { app: { ...base.app, roles } } as unknown as Manifest;
}

/** **(D) の題材で合成の本線を1回叩く**(`ask` と同じ形。題材だけが違う)。 */
function askD(params: {
  manifest: Manifest;
  roles: readonly string[];
  grantRows?: readonly Record<string, unknown>[];
  row?: Record<string, unknown>;
}): { read: boolean; write: boolean; delete: boolean } {
  const rows: Record<string, readonly Record<string, unknown>[]> = {
    book_grant: params.grantRows ?? [],
    book_member: [...MEMBER_ROWS],
  };
  const resolution = resolveCombinedRecordAccess({
    manifest: params.manifest,
    tableId: "books",
    row: params.row ?? { ...ROW_PRIVATE },
    actorId: "user-a",
    roles: [...params.roles],
    // **`groupTable` を持たない形は、上の `ask`(`:197`)と同じである** ——
    // **`RecordAccessSourceTables` は3つ目の鍵を必須にしているので、`tsc` は
    // この形を通さない。** **本葉が新しい赤を1本も足さないために、ここだけ
    // 型を明示して渡す**(答えは1ビットも変わらない。`groupTable` はこの題材に無い)。
    sources: { ...SOURCES, groupTable: undefined },
    readRows: (tableId: string) => rows[tableId] ?? [],
    readRow: (tableId: string, recordId: string) =>
      (rows[tableId] ?? []).find((one) => one._id === recordId),
  });
  if (resolution.kind !== "verdict") {
    throw new Error("この題材は辿りの上限に当たらない(符号つきの付与も鎖も持たない)");
  }
  return resolution.verdict;
}

describe("V18-M2-T10 (D0): 題材の前提(**赤の理由を題材の側に取り違えない**)", () => {
  test("(D0-1) 当たらない条件つきの規則を1本足すと、`conditional` が今日も立つ", () => {
    // **これは「壊れ方」そのものである。** **直した後もこの旗は立ったままでよい** ——
    // **狭めの判定がこの旗を見なくなるからである。**
    const decision = judgeRoleAccess({
      manifest: manifestD({ decoy: { ...DECOY_NEVER } }),
      roles: ["editor"],
      target: { target: "table", table: "books" },
      verb: "read",
      row: { ...ROW_PRIVATE },
      subject: "user-a",
    });
    expect(decision.conditional).toBe(true);
    expect(decision.allowed).toBe(true);
  });

  test("(D0-2) 条件を1つも持たない規則で許可が出たことが、判定の戻り値から分かる", () => {
    // **【今日は赤い】** **この旗は今日まだ存在しない**(`ADR-0438` §Decision 4 で足す)。
    const decision = judgeRoleAccess({
      manifest: manifestD({ decoy: { ...DECOY_NEVER } }),
      roles: ["editor"],
      target: { target: "table", table: "books" },
      verb: "read",
      row: { ...ROW_PRIVATE },
      subject: "user-a",
    });
    expect(decision.unconditionalAllow).toBe(true);
  });

  test("(D0-3) 条件つきの規則**だけ**の役割では、その旗が立たない", () => {
    const decision = judgeRoleAccess({
      manifest: manifestD({}),
      roles: ["viewer"],
      target: { target: "table", table: "books" },
      verb: "read",
      row: { ...ROW_PUBLIC },
      subject: "user-a",
    });
    expect(decision.allowed).toBe(true);
    expect(decision.unconditionalAllow ?? false).toBe(false);
  });
});

describe("V18-M2-T10 (D1): 当たらない条件つきの規則を足しても、狭めが外れない", () => {
  test("(D1-a) `editor`(条件なし read + 当たらない条件つき read)は、付与の無い行を読めない", () => {
    // **【今日は赤い】** **今日の製品は `true` を返す**(`V18-M2-T09` の実測 `1` → `3`)。
    expect(
      askD({ manifest: manifestD({ decoy: { ...DECOY_NEVER } }), roles: ["editor"] }).read,
    ).toBe(false);
  });

  test("(D1-b) 同じ題材で、その行に付与が1件あれば今日どおり読める(配りが効く)", () => {
    expect(
      askD({
        manifest: manifestD({ decoy: { ...DECOY_NEVER } }),
        roles: ["editor"],
        grantRows: [{ _id: "g-1", book: "row-1", member: "m-a", permission: "reader" }],
      }).read,
    ).toBe(true);
  });

  test("(D1-c) 合成の関数を直に叩く —— 旗が立っていれば、条件つきが在っても面は `OR` に入らない", () => {
    // **【今日は赤い】** **`unconditionalAllow` を今日の製品は1バイトも読んでいない。**
    const combined = combineRoleAndGrantAccess({
      role: {
        allowed: true,
        governed: true,
        blockedBy: null,
        conditional: true,
        unconditionalAllow: true,
      },
      grant: { read: false, write: false, delete: false },
      verb: "read",
    });
    expect(combined.allowed).toBe(false);
  });
});

describe("V18-M2-T10 (D2): 実際に当たる条件つきの規則を足しても、狭めが外れない", () => {
  test("(D2-a) `editor`(条件なし read + **当たる**条件つき read)は、付与の無い行を読めない", () => {
    // **【今日は赤い】** **条件なしの規則で既に許可が出ているので、狭める側である。**
    expect(
      askD({ manifest: manifestD({ decoy: { ...DECOY_ALWAYS } }), roles: ["editor"] }).read,
    ).toBe(false);
  });

  test("(D2-b) 同じ題材で、その行に付与が1件あれば読める", () => {
    expect(
      askD({
        manifest: manifestD({ decoy: { ...DECOY_ALWAYS } }),
        roles: ["editor"],
        grantRows: [{ _id: "g-1", book: "row-1", member: "m-a", permission: "reader" }],
      }).read,
    ).toBe(true);
  });
});

describe("V18-M2-T10 (D3): 条件つきの規則**だけ**の形は1ビットも動かさない(`D-V18-19` §10-3 の3)", () => {
  test("(D3-a) `viewer`(当たる条件つき read だけ)は、付与が1件も無くても今日どおり読める", () => {
    expect(
      askD({
        manifest: manifestD({ decoy: { ...DECOY_NEVER } }),
        roles: ["viewer"],
        row: { ...ROW_PUBLIC },
      }).read,
    ).toBe(true);
  });

  test("(D3-b) 条件が当たらない行は今日どおり読めない(狭めを緩めていない)", () => {
    expect(
      askD({
        manifest: manifestD({ decoy: { ...DECOY_NEVER } }),
        roles: ["viewer"],
        row: { ...ROW_PRIVATE },
      }).read,
    ).toBe(false);
  });

  test("(D3-c) 合成の関数を直に叩く —— 旗が立っていなければ、今日どおり `OR` に入る", () => {
    expect(
      combineRoleAndGrantAccess({
        role: { allowed: true, governed: true, blockedBy: null, conditional: true },
        grant: { read: false, write: false, delete: false },
        verb: "read",
      }).allowed,
    ).toBe(true);
  });
});

describe("V18-M2-T10 (D4): 運営者は今日どおり全部見える(`D-V18-18`)", () => {
  test("(D4-a) `owner`(条件なし read + 当たらない条件つき read)は、付与が無くても読める", () => {
    expect(
      askD({ manifest: manifestD({ ownerDecoy: { ...DECOY_NEVER } }), roles: ["owner"] }).read,
    ).toBe(true);
  });

  test("(D4-b) `owner` と `editor` を両方持つ人も、同じ題材で読める", () => {
    expect(
      askD({
        manifest: manifestD({ decoy: { ...DECOY_NEVER }, ownerDecoy: { ...DECOY_NEVER } }),
        roles: ["editor", "owner"],
      }).read,
    ).toBe(true);
  });
});

describe("V18-M2-T10 (D5): 書込・削除は1ビットも変わらない(`D-V18-17`)", () => {
  test("(D5-a) (D1) と同じ題材で、条件なしの書込は今日どおり通る", () => {
    expect(
      askD({ manifest: manifestD({ decoy: { ...DECOY_NEVER } }), roles: ["editor"] }).write,
    ).toBe(true);
  });

  test("(D5-b) (D1) と同じ題材で、削除は今日どおり通らない(面も点も許していない)", () => {
    expect(
      askD({ manifest: manifestD({ decoy: { ...DECOY_NEVER } }), roles: ["editor"] }).delete,
    ).toBe(false);
  });

  test("(D5-c) 合成の関数の書込・削除は、旗が立っていても今日どおり通る", () => {
    const role = {
      allowed: true,
      governed: true,
      blockedBy: null,
      conditional: true,
      unconditionalAllow: true,
    } as const;
    const grant = { read: false, write: false, delete: false } as const;
    expect(combineRoleAndGrantAccess({ role, grant, verb: "write" }).allowed).toBe(true);
    expect(combineRoleAndGrantAccess({ role, grant, verb: "delete" }).allowed).toBe(true);
  });
});
