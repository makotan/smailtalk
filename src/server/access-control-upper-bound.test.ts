/**
 * **`V17-M10B-T06`**: **「この行だけ閲覧のみ」の符号(`permissions[].restrictive`)を、
 * 行1件の判定に効かせる。**
 *
 * ## 本ファイルが撃つ式(**ユーザ決定4件で今日の形が確定している**)
 *
 * > **点の答え = ( ∪ **すべての**付与 ) ∩ ( ∩ 符号を持つ付与 )**
 *
 *  - **1段目に符号つきの付与も入る**(ユーザ決定 `D-V17-L`。`ADR-0430` §Decision の 4)
 *    —— **`ADR-0429` §Decision 2 の (2) が書いた「∪ 符号を**持たない**付与」から動いた。**
 *  - **2段目(交わり)には符号を持つ付与だけが入る。**
 *  - **符号を持つ付与が1件も無ければ2段目は恒真であり、答えは今日と1ビットも変わらない**
 *    (§(D) の陰性対照が撃つ)。
 *  - **【`D-V17-I`】上限は `grant.group` 経由で解けた付与にも効く**(`ADR-0429` 限定9 の
 *    **撤回**。`ADR-0430` (α))—— §(B)。
 *  - **【`D-V17-M`】上限は `inherit_from` 経由で親から降りてきた付与にも効く**
 *    (`ADR-0430` (δ))—— §(C)。**段どうしの合成は「辿り終えてから掛ける」形を採った。**
 *
 * ## 面と点の合成
 *
 * **面と点は今日どおり `OR` である。** **上限は合成の**外側**に「前提の関門」として掛かる**
 * (`ADR-0412` 限定5 と同じ置き方。`ADR-0429` §Decision 2 の (3))。
 * **したがって面が全部許していれば、同じ行に上限が在っても通る** —— **上限は面を1ミリも
 * 絞らない**(§(A) の4群目)。 **【禁止】これを「安全側に倒れる」と読まない。**
 *
 * ## **本ファイルが測っていないもの(先に書く。憲法6)**
 *
 *  1. **HTTP の4経路(画面 / 受信口 / AI / 自動処理)に届いているかを1件も測っていない**
 *     —— **`V17-M10B-T07` の担当である。** **本ファイルは述語と合成の層だけを撃つ。**
 *  2. **配る版の生成器の答えを1件も測っていない** —— **`V17-M10B-T07b`。**
 *  3. **付与を「作ってよいか」の判定(`judgeGrantWrite` 側)に上限を1バイトも掛けていない**
 *     —— **`ADR-0430` §Decision 7 の授権は和集合・関門・段どうしの合成の3つだけである。**
 *  4. **性能を1件も測っていない**(`ADR-0430` §限界 の 9)。
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Manifest } from "../kernel/index.ts";
import {
  combineRoleAndGrantAccess,
  judgeRecordAccess,
  resolveCombinedRecordAccess,
  resolveRecordAccess,
} from "./owner-scope.ts";
import { withDefaultRoleRules } from "./test-helpers.ts";

const OWNER_SCOPE_PATH = join(import.meta.dir, "owner-scope.ts");
const APP_PATH = join(import.meta.dir, "app.ts");
const REFERENTIAL_INTEGRITY_PATH = join(
  import.meta.dir,
  "..",
  "kernel",
  "referential-integrity.ts",
);
const REFERENTIAL_INTEGRITY_TEST_PATH = join(
  import.meta.dir,
  "..",
  "kernel",
  "referential-integrity.test.ts",
);

/**
 * **権限名5つ。** **後ろの2つが「これは上限である」の符号を持つ。**
 *
 * **`view_only` は「閲覧のみに絞る」、`no_delete` は「消させない」である。**
 * **どちらも3動詞とも真ではない**(3つとも真の上限は適用時検査の類型17 `項目12`
 * **条項C** が拒否する)。
 */
const PERMISSIONS = [
  { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
  { id: "writer", name: "編集できる", read: true, write: true, delete: false },
  { id: "keeper", name: "消せる", read: true, write: true, delete: true },
  {
    id: "view_only",
    name: "閲覧のみに絞る",
    read: true,
    write: false,
    delete: false,
    restrictive: true,
  },
  {
    id: "no_delete",
    name: "消させない",
    read: true,
    write: true,
    delete: false,
    restrictive: true,
  },
] as const;

/** **符号を1本も持たない権限名だけの一覧**(陰性対照。§(D))。 */
const PERMISSIONS_WITHOUT_SIGN = PERMISSIONS.filter(
  (permission) => !("restrictive" in permission),
).map((permission) => ({ ...permission }));

const PERMISSION_OPTIONS = PERMISSIONS.map((permission) => permission.id);

function manifest(options?: { permissions?: readonly Record<string, unknown>[] }): Manifest {
  return {
    app: {
      id: "book-shelf",
      name: "蔵書",
      roles: [],
      tables: [
        {
          id: "books",
          name: "書籍",
          fields: [
            { id: "title", name: "タイトル", type: "text", required: true },
            { id: "parent", name: "親", type: "reference", reference_table: "books" },
          ],
          access_control: {
            enabled: true,
            permissions: options?.permissions ?? PERMISSIONS.map((one) => ({ ...one })),
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
              options: [...PERMISSION_OPTIONS],
            },
          ],
        },
      ],
      views: [],
    },
  } as unknown as Manifest;
}

/** **引き継ぎ(`inherit_from`)を宣言した題材**(§(C))。 */
function inheritManifest(): Manifest {
  const base = manifest() as unknown as {
    app: { tables: { id: string; access_control?: Record<string, unknown> }[] };
  };
  const books = base.app.tables.find((table) => table.id === "books");
  if (books?.access_control === undefined) {
    throw new Error("題材に books の宣言が無い");
  }
  books.access_control.inherit_from = ["parent"];
  return base as unknown as Manifest;
}

const MEMBER_ROWS = [
  { _id: "m-a", account: "user-a" },
  { _id: "m-b", account: "user-b", team: "t-1" },
];

const ROW = { _id: "row-1", title: "吾輩は猫である" };

/**
 * **【陽性対照の相手】「全部通す」= 上限を1件も見ない実装**(罠14)。
 *
 * **これは 2026-09-10 の実施**前**の製品の答えとまったく同じ式である** ——
 * **付与から解けた権限名を `read` / `write` / `delete` ごとに `or` で重ねるだけで、
 * 符号を1ビットも見ない。** **§(E) が、製品の答えがこの式と**割れる**ことを撃つ。**
 * **割れなければ、上限はどこにも入っていない。**
 */
function unionOnlyReference(params: {
  permissions: readonly Record<string, unknown>[];
  names: readonly string[];
}): { read: boolean; write: boolean; delete: boolean } {
  let read = false;
  let write = false;
  let remove = false;
  for (const permission of params.permissions) {
    if (!params.names.includes(String(permission.id))) {
      continue;
    }
    read = read || permission.read === true;
    write = write || permission.write === true;
    remove = remove || permission.delete === true;
  }
  return { read, write, delete: remove };
}

// ---------------------------------------------------------------------------
// (A) 4群 —— **同じ人・同じ行で、付与の形だけを変える**(`V17-M10B` 完了条件18)
// ---------------------------------------------------------------------------

describe("V17-M10B-T06 (A): 4群 —— 同じ人・同じ行で、付与の形だけを変える", () => {
  const base = manifest();
  const judge = (grantRows: readonly Record<string, unknown>[]) =>
    judgeRecordAccess({
      manifest: base,
      tableId: "books",
      row: ROW,
      actorId: "user-a",
      grantRows,
      memberRows: MEMBER_ROWS,
    });

  test("(A-1) 群1: 強い付与だけ(符号なし)—— 今日と1ビットも変わらない", () => {
    expect(judge([{ _id: "g-1", book: "row-1", member: "m-a", permission: "keeper" }])).toEqual({
      read: true,
      write: true,
      delete: true,
    });
  });

  test("(A-2) 群2: 強い付与 + 上限 —— 上限まで絞られる", () => {
    // **1段目 = `keeper` ∪ `view_only` = {読 真, 書 真, 消 真}。**
    // **2段目 = `view_only` = {読 真, 書 偽, 消 偽}。** **交わりが答えである。**
    expect(
      judge([
        { _id: "g-1", book: "row-1", member: "m-a", permission: "keeper" },
        { _id: "g-2", book: "row-1", member: "m-a", permission: "view_only" },
      ]),
    ).toEqual({ read: true, write: false, delete: false });
  });

  test("(A-3) 群3: 上限だけ —— `D-V17-L` のとおり「読める」(上限も渡す側に入る)", () => {
    // **`ADR-0429` §Decision 2 の (2) の式(1段目 = ∪ 符号を**持たない**付与)なら、
    // ここは1段目が空になって {読 偽, 書 偽, 消 偽} である。** **`D-V17-L` はそれを採らない。**
    expect(judge([{ _id: "g-1", book: "row-1", member: "m-a", permission: "view_only" }])).toEqual({
      read: true,
      write: false,
      delete: false,
    });
  });

  test("(A-4) 群4: 面が全部許す + 上限 —— 面は OR なので通る(上限は面を絞らない)", () => {
    const withRoles = withDefaultRoleRules(manifest());
    const grantRows = [{ _id: "g-1", book: "row-1", member: "m-a", permission: "view_only" }];
    const rows: Record<string, readonly Record<string, unknown>[]> = {
      book_grant: grantRows,
      book_member: MEMBER_ROWS,
      book_team: [{ _id: "t-1", title: "編集班" }],
    };
    const resolution = resolveCombinedRecordAccess({
      manifest: withRoles,
      tableId: "books",
      row: ROW,
      actorId: "user-a",
      roles: ["owner"],
      sources: { grantTable: "book_grant", memberTable: "book_member", groupTable: "book_team" },
      readRows: (tableId) => rows[tableId] ?? [],
      readRow: () => undefined,
    });
    expect(resolution.kind).toBe("verdict");
    if (resolution.kind !== "verdict") {
      throw new Error("上限に当たっていない題材である");
    }
    // **面(`owner` の表の規則 = 読 / 書 / 消)が全部許すので、`OR` で3つとも通る。**
    expect(resolution.verdict).toEqual({ read: true, write: true, delete: true });
    // **点の側は上限で止まっている** —— **止めた層は今日どおり `"grant"` を名乗る**
    // (`AccessLayerName` は2値のまま。`ADR-0308` 限定8 / `ADR-0429` 限定10)。
    expect(resolution.blockedBy.write).toEqual(["grant"]);
    expect(resolution.blockedBy.delete).toEqual(["grant"]);
    expect(resolution.blockedBy.read).toEqual([]);
  });

  test("(A-5) 上限どうしは交わる(引き算を1つも作っていない)", () => {
    // **`view_only` ∩ `no_delete` = {読 真, 書 偽, 消 偽}。**
    // **上限は「その動詞を奪う」のではなく「そこまでしか渡さない」である** ——
    // **`no_delete` が `write` を真にしていても、`view_only` が偽にしているので書けない。**
    expect(
      judge([
        { _id: "g-1", book: "row-1", member: "m-a", permission: "keeper" },
        { _id: "g-2", book: "row-1", member: "m-a", permission: "no_delete" },
        { _id: "g-3", book: "row-1", member: "m-a", permission: "view_only" },
      ]),
    ).toEqual({ read: true, write: false, delete: false });
  });

  test("(A-6) 付与行の並び順で答えが変わらない(和集合も交わりも可換)", () => {
    const rows = [
      { _id: "g-1", book: "row-1", member: "m-a", permission: "keeper" },
      { _id: "g-2", book: "row-1", member: "m-a", permission: "view_only" },
      { _id: "g-3", book: "row-1", member: "m-a", permission: "no_delete" },
    ];
    const forward = judge(rows);
    const backward = judge([...rows].reverse());
    expect(forward).toEqual(backward);
    expect(forward).toEqual({ read: true, write: false, delete: false });
  });
});

// ---------------------------------------------------------------------------
// (B) `D-V17-I` —— **`grant.group` 経由で解けた付与にも上限が効く**
// ---------------------------------------------------------------------------

describe("V17-M10B-T06 (B): グループ経由で解けた付与にも上限が効く(D-V17-I)", () => {
  const base = manifest();

  test("(B-1) 直接の強い付与 + グループ経由の上限 → 上限まで絞られる", () => {
    // **`ADR-0429` 限定9(逐語「上限が効くのは `grant.member` 経由の直接の付与だけ」)は
    // `ADR-0430` (α) が**撤回**した。** **撤回であって、緩和でも読み替えでもない。**
    // **その帰結を丸めずに書く**: **`user-b` はグループ `t-1` に入ったことで、
    // 同じ行の `write` と `delete` を失う** —— **「チームに入れたら権限が減る」が
    // 実際に起きる**(`ADR-0430` §Decision の 3)。
    expect(
      judgeRecordAccess({
        manifest: base,
        tableId: "books",
        row: ROW,
        actorId: "user-b",
        grantRows: [
          { _id: "g-1", book: "row-1", member: "m-b", permission: "keeper" },
          { _id: "g-2", book: "row-1", team: "t-1", permission: "view_only" },
        ],
        memberRows: MEMBER_ROWS,
      }),
    ).toEqual({ read: true, write: false, delete: false });
  });

  test("(B-2) 同じ付与行の並びでも、グループに入っていない人には上限が1ミリも効かない", () => {
    // **`user-a` はどのグループにも属さないので、グループ経由の上限は解けない** ——
    // **交わりの側に1件も入らないので、答えは強い付与のままである。**
    expect(
      judgeRecordAccess({
        manifest: base,
        tableId: "books",
        row: ROW,
        actorId: "user-a",
        grantRows: [
          { _id: "g-1", book: "row-1", member: "m-a", permission: "keeper" },
          { _id: "g-2", book: "row-1", team: "t-1", permission: "view_only" },
        ],
        memberRows: MEMBER_ROWS,
      }),
    ).toEqual({ read: true, write: true, delete: true });
  });

  test("(B-3) グループ経由の上限だけでも「読める」(D-V17-L はグループ経由でも同じ)", () => {
    expect(
      judgeRecordAccess({
        manifest: base,
        tableId: "books",
        row: ROW,
        actorId: "user-b",
        grantRows: [{ _id: "g-1", book: "row-1", team: "t-1", permission: "view_only" }],
        memberRows: MEMBER_ROWS,
      }),
    ).toEqual({ read: true, write: false, delete: false });
  });
});

// ---------------------------------------------------------------------------
// (C) `D-V17-M` —— **引き継ぎ経由で降りてきた付与にも上限が効く(深さ1以上)**
// ---------------------------------------------------------------------------

describe("V17-M10B-T06 (C): 引き継ぎの段をまたいでも上限が効く(D-V17-M)", () => {
  const base = inheritManifest();
  /** 段0 = `row-child`(親は `row-parent`)。**深さ1を必ず含む。** */
  const child = { _id: "row-child", title: "子", parent: "row-parent" };
  const parent = { _id: "row-parent", title: "親", parent: null };

  const resolve = (grantRows: readonly Record<string, unknown>[]) => {
    const rows: Record<string, readonly Record<string, unknown>[]> = {
      book_grant: grantRows,
      book_member: MEMBER_ROWS,
      book_team: [{ _id: "t-1", title: "編集班" }],
      books: [child, parent],
    };
    return resolveRecordAccess({
      manifest: base,
      tableId: "books",
      row: child,
      actorId: "user-a",
      readRows: (tableId) => rows[tableId] ?? [],
      readRow: (tableId, recordId) =>
        (rows[tableId] ?? []).find((candidate) => candidate._id === recordId),
    });
  };

  test("(C-1) 段0 に上限、親の段に強い付与 —— 親の強い付与で足し戻されない", () => {
    // **`ADR-0430` (δ) の逐語**: 「**段0 に上限を書いた行が、親の段の強い付与で
    // 足し戻されない。**」
    // **段ごとに掛けてから `OR` で重ねると、親の段は上限を1件も持たないので
    // {読 真, 書 真, 消 真} を出し、答えが足し戻る。** **本葉は「辿り終えてから掛ける」を
    // 採った**(`ADR-0430` §誇張しない の 6 が `V17-M10B-T06` に委ねた選択である)。
    expect(
      resolve([
        { _id: "g-1", book: "row-child", member: "m-a", permission: "view_only" },
        { _id: "g-2", book: "row-parent", member: "m-a", permission: "keeper" },
      ]),
    ).toEqual({ kind: "verdict", verdict: { read: true, write: false, delete: false } });
  });

  test("(C-2) 親の段に上限、段0 に強い付与 —— 親から降りてきた上限が子を絞る", () => {
    expect(
      resolve([
        { _id: "g-1", book: "row-child", member: "m-a", permission: "keeper" },
        { _id: "g-2", book: "row-parent", member: "m-a", permission: "view_only" },
      ]),
    ).toEqual({ kind: "verdict", verdict: { read: true, write: false, delete: false } });
  });

  test("(C-3) 親の段にしか付与が無くても、そこに書いた上限がそのまま子の答えになる", () => {
    expect(
      resolve([{ _id: "g-2", book: "row-parent", member: "m-a", permission: "view_only" }]),
    ).toEqual({ kind: "verdict", verdict: { read: true, write: false, delete: false } });
  });

  test("(C-4) 段のどこにも符号が無ければ、引き継ぎの答えは今日と1ビットも変わらない", () => {
    expect(
      resolve([
        { _id: "g-1", book: "row-child", member: "m-a", permission: "reader" },
        { _id: "g-2", book: "row-parent", member: "m-a", permission: "keeper" },
      ]),
    ).toEqual({ kind: "verdict", verdict: { read: true, write: true, delete: true } });
  });
});

// ---------------------------------------------------------------------------
// (D) 陰性対照 —— **符号を1つも書かないアプリの答えは今日と1ビットも変わらない**
// ---------------------------------------------------------------------------

describe("V17-M10B-T06 (D): 符号を1つも書かない題材は今日と1ビットも変わらない", () => {
  const plain = manifest({ permissions: PERMISSIONS_WITHOUT_SIGN });

  test("(D-1) 符号を1本も持たない宣言には、`restrictive` の綴りが1つも無い", () => {
    expect(PERMISSIONS_WITHOUT_SIGN.some((permission) => "restrictive" in permission)).toBe(false);
    expect(PERMISSIONS_WITHOUT_SIGN.length).toBe(3);
  });

  test("(D-2) 8通りの付与の組み合わせが、上限を1件も見ない式と1ビットも違わない", () => {
    const names = ["reader", "writer", "keeper"];
    const combinations: string[][] = [];
    for (let mask = 0; mask < 8; mask += 1) {
      combinations.push(names.filter((_, index) => (mask & (1 << index)) !== 0));
    }
    expect(combinations.length).toBe(8);
    for (const combination of combinations) {
      const grantRows = combination.map((permission, index) => ({
        _id: `g-${index}`,
        book: "row-1",
        member: "m-a",
        permission,
      }));
      const actual = judgeRecordAccess({
        manifest: plain,
        tableId: "books",
        row: ROW,
        actorId: "user-a",
        grantRows,
        memberRows: MEMBER_ROWS,
      });
      // **付与が1件も無い人は今日どおり3つとも偽である**(fail-closed)。
      const expected =
        combination.length === 0
          ? { read: false, write: false, delete: false }
          : unionOnlyReference({ permissions: PERMISSIONS_WITHOUT_SIGN, names: combination });
      expect(actual).toEqual(expected);
    }
  });

  test("(D-3) 宣言していない表は今日どおり3つとも真である(オプトイン)", () => {
    expect(
      judgeRecordAccess({
        manifest: plain,
        tableId: "book_team",
        row: { _id: "t-1" },
        actorId: "user-a",
        grantRows: [],
        memberRows: MEMBER_ROWS,
      }),
    ).toEqual({ read: true, write: true, delete: true });
  });
});

// ---------------------------------------------------------------------------
// (E) 陽性対照 —— **「全部通す」実装をその場で落とす**(罠14)
// ---------------------------------------------------------------------------

describe("V17-M10B-T06 (E): 陽性対照 —— 上限を1件も見ない実装は、この検査を通れない", () => {
  const base = manifest();
  const names = ["keeper", "view_only"];

  test("(E-1) 製品の答えが、上限を1件も見ない式と割れる", () => {
    const actual = judgeRecordAccess({
      manifest: base,
      tableId: "books",
      row: ROW,
      actorId: "user-a",
      grantRows: [
        { _id: "g-1", book: "row-1", member: "m-a", permission: "keeper" },
        { _id: "g-2", book: "row-1", member: "m-a", permission: "view_only" },
      ],
      memberRows: MEMBER_ROWS,
    });
    const passAll = unionOnlyReference({ permissions: [...PERMISSIONS], names });
    // **上限を1件も見ない式は {読 真, 書 真, 消 真} を出す** —— **2026-09-10 の実施前の
    // 製品の答えそのものである。**
    expect(passAll).toEqual({ read: true, write: true, delete: true });
    // **製品の答えはそれと割れていなければならない。** **割れていなければ、上限は
    // どこにも入っていない。**
    expect(actual).not.toEqual(passAll);
    expect(actual).toEqual({ read: true, write: false, delete: false });
  });
});

// ---------------------------------------------------------------------------
// (F) 合成の答えを消費する6箇所 —— **`ADR-0429` 限定8**
// ---------------------------------------------------------------------------

describe("V17-M10B-T06 (F): 合成の答えを消費する6箇所に、同じ規則が入っている", () => {
  test("(F-1) 消費する非テスト製品コードは今日も6箇所ちょうどである", async () => {
    const ownerScope = await Bun.file(OWNER_SCOPE_PATH).text();
    const app = await Bun.file(APP_PATH).text();
    const countCalls = (source: string): number =>
      source.split("combineRoleAndGrantAccess({").length - 1;
    // **`owner-scope.ts` の4箇所**(`combineRoleAndCreatorGrant` の1本 +
    // `resolveCombinedRecordAccess` の動詞3本)。
    expect(countCalls(ownerScope)).toBe(4);
    // **`app.ts` の2箇所**(単件の作成の下見 / まとめ書きの作成の下見)。
    expect(countCalls(app)).toBe(2);
    expect(countCalls(ownerScope) + countCalls(app)).toBe(6);
  });

  test("(F-2) 6箇所のうち4箇所 —— 点の答えは上限を通ったものだけが渡る", () => {
    // **`resolveCombinedRecordAccess` の3箇所は `resolveRecordAccess` の答えを渡す** ——
    // **その答えには辿り終えたあとで上限が掛かっている**(§(C))。
    // **【行を持つ経路で、上限が実際に合成へ届いていることを撃つ】**
    const withRoles = withDefaultRoleRules(manifest(), { skipTables: ["books"] });
    const rows: Record<string, readonly Record<string, unknown>[]> = {
      book_grant: [
        { _id: "g-1", book: "row-1", member: "m-a", permission: "keeper" },
        { _id: "g-2", book: "row-1", member: "m-a", permission: "view_only" },
      ],
      book_member: MEMBER_ROWS,
      book_team: [{ _id: "t-1", title: "編集班" }],
    };
    const resolution = resolveCombinedRecordAccess({
      manifest: withRoles,
      tableId: "books",
      row: ROW,
      actorId: "user-a",
      roles: ["viewer"],
      sources: { grantTable: "book_grant", memberTable: "book_member", groupTable: "book_team" },
      readRows: (tableId) => rows[tableId] ?? [],
      readRow: () => undefined,
    });
    expect(resolution.kind).toBe("verdict");
    if (resolution.kind !== "verdict") {
      throw new Error("上限に当たっていない題材である");
    }
    // **面はこの表に規則を1本も持たない(`skipTables`)ので、答えは点の側だけで決まる。**
    expect(resolution.verdict).toEqual({ read: true, write: false, delete: false });
    // **4箇所目 = `combineRoleAndCreatorGrant`。** **こちらは行がまだ無い下見であり、
    // 点の材料は付与行ではない**(下の (F-3) と同じ理由で構造的に恒真である)。
    expect(
      combineRoleAndGrantAccess({
        role: { governed: true, allowed: false, blockedBy: "role", conditional: false },
        grant: { read: true, write: false, delete: false },
        verb: "write",
      }).allowed,
    ).toBe(false);
  });

  test("(F-2b) 4箇所目(作成の下見)は、点の材料が付与行ではない —— ここも恒真である", async () => {
    // **【`ADR-0430` §Decision の 6 との食い違いを、丸めずに書く】**
    // **条文は「上限が構造的に恒真である下見の口」を `app.ts:6582` / `:7686` の **2箇所**
    // と書いている。** **本葉が6箇所を実際に開いて読んだところ、`owner-scope.ts` の
    // `combineRoleAndCreatorGrant` も同じ性質を持つ** —— **合成へ渡す点の答えを
    // `CreatorGrantPlan` から**その場で組み立てて**おり、付与行から1件も解いていない。**
    // **したがって上限の関門はこの箇所を1度も通らない。**
    // **【正直に】条文がこの1箇所を挙げていないのは、条文が「`owner-scope.ts` の外に在るか」
    // で2箇所を選んだからであって、恒真の数を3と数え違えたわけではない。**
    // **本葉は条文を1バイトも書き換えていない。**
    const ownerScope = await Bun.file(OWNER_SCOPE_PATH).text();
    const at = ownerScope.indexOf("export function combineRoleAndCreatorGrant(params: {");
    expect(at).toBeGreaterThan(0);
    const body = ownerScope.slice(at, ownerScope.indexOf("\n}\n", at));
    // **点の答えはその場で組み立てた3ブールである**(逐語)。
    expect(body).toContain(
      ': { read: false, write: params.plan.kind !== "no_member", delete: false }',
    );
    // **付与行にも、上限にも、段の解決にも、1文字も触れていない。**
    expect(body.includes("grantRows")).toBe(false);
    expect(body.includes("restrictive")).toBe(false);
    expect(body.includes("recordAccessStages(")).toBe(false);
  });

  test("(F-3) 残る2箇所は上限が構造的に恒真である。根拠を逐語で置く", async () => {
    // ===================================================================
    // **【完了条件17。`ADR-0430` §Decision の 6 の逐語をそのまま置く】**
    //
    // > **どちらも、合成に渡す `grant` の値を**付与行から解いていない**。**
    // > **`creator_permission` から導いた到達可能性を3動詞に同じ値で敷いた
    // > `{ read: reachable, write: reachable, delete: reachable }` を渡している。**
    // > **その行はまだ存在しない**(これから作る行の下見である)。 **したがってその行を
    // > 指す付与行は1件も無く、上限の符号を持つ付与も1件も無い。**
    // > **よって上限の関門は、この2箇所では**常に真**である** —— **恒真であって、
    // > 「効いている」のでも「効いていない」のでもない。**
    //
    // > **【この恒真の根拠は条文ではない】** **`creator_permission` が上限の符号を持つ
    // > 権限名を指せてしまうなら、`reachable` の導出にその権限名が入り、恒真は崩れる。**
    // > **それを止めているのは本 ADR でも `ADR-0429` でもなく、
    // > `apps/smailtalk/src/kernel/referential-integrity.ts` の類型17 `項目12`
    // > **条項A**(`creator_permission` が絞る側の権限名を指している宣言を拒否する)である。**
    //
    // > **【依存を1行で書く】** **条項A を外すと、`app.ts:6582` / `:7686` の2箇所の
    // > 恒真の根拠が消える。**
    //
    // **【禁止】これを「上限が効いている」と読まない。** **恒真である。**
    // ===================================================================
    const app = await Bun.file(APP_PATH).text();
    // **(a) 2箇所とも、渡している `grant` は付与行から解いたものではない。**
    const literal = "grant: { read: reachable, write: reachable, delete: reachable },";
    expect(app.split(literal).length - 1).toBe(2);

    // **(b) 2箇所が下敷きにする点の答えは、`creator_permission` 1本だけを載せた
    // 「下見の付与行」から解かれる。** **その権限名が絞る側でなければ、2段目は
    // 交わりの単位元(3つとも真)であり、関門は**恒真**である。**
    // **`creator_permission` は題材では `keeper`(符号を持たない)である。**
    const preview = judgeRecordAccess({
      manifest: manifest(),
      tableId: "books",
      row: ROW,
      actorId: "user-a",
      grantRows: [{ _id: "preview", book: "row-1", member: "m-a", permission: "keeper" }],
      memberRows: MEMBER_ROWS,
    });
    expect(preview).toEqual({ read: true, write: true, delete: true });
    // **上限を1件も見ない式と1ビットも違わない** —— **これが「恒真」の中身である。**
    expect(preview).toEqual(
      unionOnlyReference({ permissions: [...PERMISSIONS], names: ["keeper"] }),
    );

    // **(c) 恒真の根拠が今日も切れていないこと** —— **`creator_permission` に上限の符号を
    // 持つ権限名を指した宣言は、適用時検査の類型17 `項目12` **条項A** が拒否する。**
    // **本ファイルは `src/kernel/` の値を1つも import しない**(`ADR-0009` 限定2 の
    // 取り込みの一覧を1行も動かさないため)—— **条項A の実在を綴りで、拒否のふるまいを
    // `src/kernel/referential-integrity.test.ts` の `(13a)` の実在で撃つ。**
    const integrity = await Bun.file(REFERENTIAL_INTEGRITY_PATH).text();
    expect(integrity).toContain(
      "**条項A**: `creator_permission` が絞る側の権限名を指している宣言を拒否する。",
    );
    expect(integrity).toContain("isRestrictivePermission(permission),");
    const integrityTest = await Bun.file(REFERENTIAL_INTEGRITY_TEST_PATH).text();
    expect(integrityTest).toContain('test("(13a) 行を作った人に渡す権限が絞る側だと拒否される"');
  });
});

// ---------------------------------------------------------------------------
// (G) 守る線 —— **越えていないことを機械で固定する**
// ---------------------------------------------------------------------------

describe("V17-M10B-T06 (G): 越えていない線", () => {
  test("(G-1) 判定の戻り値は3キーのまま(`ADR-0297` 限定6)", () => {
    const verdict = judgeRecordAccess({
      manifest: manifest(),
      tableId: "books",
      row: ROW,
      actorId: "user-a",
      grantRows: [{ _id: "g-1", book: "row-1", member: "m-a", permission: "view_only" }],
      memberRows: MEMBER_ROWS,
    });
    expect(Object.keys(verdict).sort()).toEqual(["delete", "read", "write"]);
  });

  test("(G-2) 判定の中心の関数の引数キーは6本のまま(`ADR-0294` 限定5 ほか)", async () => {
    const source = await Bun.file(OWNER_SCOPE_PATH).text();
    const signature = /export function judgeRecordAccess\(params: \{([\s\S]*?)\n\}\)/.exec(source);
    expect(signature).not.toBeNull();
    const keys = ((signature as RegExpExecArray)[1] ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => (line.split(":")[0] ?? "").trim());
    expect(keys).toEqual(["manifest", "tableId", "row", "actorId", "grantRows", "memberRows"]);
  });

  test("(G-3) `AccessLayerName` は2値のまま(`ADR-0308` 限定8)", async () => {
    const source = await Bun.file(OWNER_SCOPE_PATH).text();
    expect(source).toContain('export type AccessLayerName = "role" | "grant";');
  });

  // =====================================================================================
  // **【2026-09-11 追記(`V18-M2-T04`。`PM-G8` / `PM-G11` / `ADR-0431` §Decision 2 の4行目)。
  // 直下の `(G-4)` の2つの期待値を打ち直した。旧文を1バイトも消していない】**
  //
  //     旧: expect(new TextEncoder().encode(body).length).toBe(896);
  //     新: expect(new TextEncoder().encode(body).length).toBe(1598);
  //     旧: expect(digest).toBe("2e630207fb6e89893d82414325f138868a6fb433e5b1c9b2224d91a945561947");
  //     新: expect(digest).toBe("3ac6d7c01042dd0617201b11225d73b706ec75ce0c44d90b3a57b2a9d6209b1e");
  //
  // **なぜ期待値の側が今日の正でなくなったか** —— **`combineRoleAndGrantAccess` の本体に、
  // 読取の面の絞り(`faceCarries`)と運営者の例外(ユーザ決定 `D-V18-18`)を書いたためである。**
  // **`ADR-0431` §Decision 2 の4行目が、この2値の打ち直しを名指しで授権している。**
  //
  // **【この検査の題名は今日の正ではない。隠さない】** **題名の「896バイト のまま」は
  // **偽**である**(今日は 1598バイト)。 **題名を書き換えなかったのは、授権が
  // 「2つの期待値を打ち直すことだけ」と定めているからである** —— **題名の書き換えは
  // その2つに入らない。** **`V18-M2-T08` / `CP-V18` 条件6 への申し送りとして、
  // 「赤くならないまま題名だけが嘘になっている1本」をここに書いておく。**
  //
  // **【1バイトも触っていない側】** **`(G-1)`〜`(G-3)` と `(G-5)` 以降。**
  // **上限の群4(`:251`。**この節では綴りを出さない** —— `ADR-0437` 限定7 の式が
  // この差分の中にその綴りが1件も無いことを数えるためである)の期待値も、1バイトも触っていない
  // (ユーザ決定 `D-V18-17`)。
  // =====================================================================================
  // **【2026-09-11 追記(同日2度目。`V18-M2-T10`。ユーザ決定 `D-V18-19` /
  // `ADR-0438` 行14)。直下の `(G-4)` の2つの期待値を**2度目に**打ち直した。
  // 旧文を1バイトも消していない】**
  //
  //     旧(1度目の打ち直しの値): expect(new TextEncoder().encode(body).length).toBe(1598);
  //     新: expect(new TextEncoder().encode(body).length).toBe(2499);
  //     旧(1度目の打ち直しの値): expect(digest).toBe("3ac6d7c01042dd0617201b11225d73b706ec75ce0c44d90b3a57b2a9d6209b1e");
  //     新: expect(digest).toBe("44fbc7b58a1f51db0957dfda0742a6f2a9ccb983995062e09e82a363472ca715");
  //
  // **なぜ期待値の側が今日の正でなくなったか** —— **`faceCarries` の条件を
  // `!params.role.conditional` から `params.role.unconditionalAllow === true` へ
  // 差し替え、旧の逐語と理由を本体の直上にコメントとして残したためである**
  // (`ADR-0438` §Decision 4)。
  // **`ADR-0438` 行14 が「`ADR-0431` §Decision 2 の4行目の授権は1回限りではない」と
  // 明示して、この2度目の打ち直しを授権している。**
  //
  // **【題名は今日も正ではない。2度目も隠さない】** **題名の「896バイト のまま」は
  // 今日 **2499バイト** であり、偽である。** **授権が「2つの期待値を打ち直すことだけ」と
  // 定めているので、題名は今日も書き換えていない。**
  //
  // **【1バイトも触っていない側】** **`(G-1)`〜`(G-3)` と `(G-5)` 以降。**
  // **上限の群4(`:251`。**この節でも綴りを出さない**)の期待値も、1バイトも触っていない
  // (ユーザ決定 `D-V18-17`)。
  // =====================================================================================
  // **【2026-09-17 改名(`V18-M9-T10` / `D-V18-37` / `ADR-0446` 授権の表 行4)。
  //   直下の `(G-4)` の**題名だけ**を今日の正に改めた。
  //   この検査が実際に撃っている2つの期待値(本体のバイト数と sha256)は、
  //   1バイトも動かしていない。旧の題名は下に逐語で残し、1バイトも消していない】**
  //
  //     旧(逐語): test("(G-4) 合成の関数の本体は 896バイト のまま(`ADR-0430` 限定17)", async () => {
  //
  // **なぜ旧の題名が今日は偽か** —— **題名は **896バイト** と名乗るのに、この検査が実際に
  // 撃っている値は **2499** だからである**(`V18-M2-T10` が2度目の打ち直しを入れた。
  // `ADR-0438` 行14 の授権)。 **凍結の**中身**は今日も真であり、偽なのは**題名**だけであった。**
  //
  // **【直上の2つの注記(2026-09-11 の帯)を1バイトも消していない】**
  // **そこに在る逐語「題名は今日も書き換えていない」「授権が…と定めているので、題名は
  // 今日も書き換えていない」は、本改名をもって今日は偽になる。** **消さずに残すのが
  // このリポジトリの作法なので、ここに訂正だけを足す。**
  // =====================================================================================
  test("(G-4) 合成の関数の本体は 2499バイト のまま(`ADR-0430` 限定17 / `ADR-0438`)", async () => {
    const source = await Bun.file(OWNER_SCOPE_PATH).text();
    const lines = source.split("\n");
    const start = lines.indexOf("export function combineRoleAndGrantAccess(params: {");
    expect(start).toBeGreaterThan(-1);
    let end = -1;
    for (let index = start; index < lines.length; index += 1) {
      if (lines[index] === "}") {
        end = index;
        break;
      }
    }
    expect(end).toBeGreaterThan(start);
    const body = `${lines.slice(start, end + 1).join("\n")}\n`;
    expect(new TextEncoder().encode(body).length).toBe(2499);
    const digest = new Bun.CryptoHasher("sha256").update(body).digest("hex");
    // **着手前に打った値。1バイトも変えていないことを凍結する。**
    expect(digest).toBe("44fbc7b58a1f51db0957dfda0742a6f2a9ccb983995062e09e82a363472ca715");
  });

  test("(G-5) 付与行どうしの合成に引き算(拒否の付与)を1つも作っていない", () => {
    // **上限は「その動詞を奪う」ものではない** —— **上限だけを持つ人は、その上限が
    // 許す動詞をそのまま受け取る**(`D-V17-L`)。 **もし引き算にしていたら、
    // 下の答えは3つとも偽になる。**
    expect(
      judgeRecordAccess({
        manifest: manifest(),
        tableId: "books",
        row: ROW,
        actorId: "user-a",
        grantRows: [{ _id: "g-1", book: "row-1", member: "m-a", permission: "no_delete" }],
        memberRows: MEMBER_ROWS,
      }),
    ).toEqual({ read: true, write: true, delete: false });
  });
});
