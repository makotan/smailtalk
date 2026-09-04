import { describe, expect, test } from "bun:test";
import type { Manifest, Table } from "../kernel/index.ts";
import {
  accessControlOf,
  accessControlTableRoles,
  isAccessControlledTable,
  isGrantTable,
  isGroupTable,
  isMemberTable,
} from "./owner-scope.ts";

/**
 * **`V7-M1-T04` / `Z-G2` / `Z-G3` / `Z-G4` / `Z-G6` / `Z-G7`**:
 * **サーバが付与表・グループ表・メンバー表を「規約として認識する」ところまで。**
 *
 * **本ファイルは判定(可視性・書込可否)を1バイトも測らない** —— それは `V7-M3` の担当である。
 * ここで測るのは **「この表は何であるか」を返す純粋述語**だけである。
 *
 * **述語は I/O を持たない**(マニフェストと表IDだけを入力にする)。**入力を破壊しない。**
 */

/** `v7-m0.md` §5-2 (a) の確定形を、蔵書アプリの表名で書いたもの。 */
const DECLARATION = {
  enabled: true,
  permissions: [
    { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
    { id: "writer", name: "編集可", read: true, write: true, delete: false },
  ],
  creator_permission: "writer",
  grant: {
    table: "book_grant",
    target: "target",
    member: "member",
    group: "group",
    permission: "permission",
  },
  members: { table: "member", account: "account", group: "group" },
  groups: { table: "team" },
  inherit_from: [],
} as const;

function manifestWith(accessControl: unknown): Manifest {
  const books: Table = {
    id: "books",
    name: "書籍",
    fields: [{ id: "title", name: "タイトル", type: "text" }],
  };
  if (accessControl !== undefined) {
    (books as unknown as Record<string, unknown>).access_control = accessControl;
  }
  return {
    app: {
      id: "book-tracker",
      name: "蔵書管理",
      tables: [
        books,
        {
          id: "team",
          name: "グループ",
          fields: [{ id: "title", name: "名前", type: "text" }],
        },
        {
          id: "member",
          name: "利用者",
          fields: [
            { id: "account", name: "ログイン", type: "text" },
            { id: "group", name: "グループ", type: "reference", reference_table: "team" },
          ],
        },
        {
          id: "book_grant",
          name: "本の付与",
          fields: [
            { id: "target", name: "本", type: "reference", reference_table: "books" },
            { id: "member", name: "利用者", type: "reference", reference_table: "member" },
            { id: "group", name: "グループ", type: "reference", reference_table: "team" },
            { id: "permission", name: "権限", type: "select", options: ["reader", "writer"] },
          ],
        },
      ],
      views: [],
    },
  } as Manifest;
}

function tableOf(manifest: Manifest, tableId: string): Table {
  const table = manifest.app.tables.find((candidate) => candidate.id === tableId);
  if (table === undefined) {
    throw new Error(`表 "${tableId}" がフィクスチャに無い`);
  }
  return table;
}

describe("V7-M1-T04 (a): 表そのものの宣言を読む(accessControlOf / isAccessControlledTable)", () => {
  test("宣言していない表は undefined を返す(オプトイン)", () => {
    const manifest = manifestWith(undefined);
    expect(accessControlOf(tableOf(manifest, "books"))).toBeUndefined();
    expect(isAccessControlledTable(tableOf(manifest, "books"))).toBe(false);
  });

  test("enabled: true の表は宣言そのものを返す", () => {
    const manifest = manifestWith(DECLARATION);
    expect(accessControlOf(tableOf(manifest, "books"))).toEqual(
      DECLARATION as unknown as NonNullable<Table["access_control"]>,
    );
    expect(isAccessControlledTable(tableOf(manifest, "books"))).toBe(true);
  });

  test("enabled: false は「宣言していない表」と同じ扱いである(v7-m0.md §5-2 (a) の5)", () => {
    const manifest = manifestWith({ ...DECLARATION, enabled: false });
    expect(accessControlOf(tableOf(manifest, "books"))).toBeUndefined();
    expect(isAccessControlledTable(tableOf(manifest, "books"))).toBe(false);
  });

  test("enabled が真偽値でない壊れた宣言は、無効として扱う(例外を投げない)", () => {
    // **schema が弾く形だが、述語の側で例外を投げると読取経路が 500 になる**
    // (`declaredUserKinds` の doc と同じ理由)。
    const manifest = manifestWith({ ...DECLARATION, enabled: "true" });
    expect(accessControlOf(tableOf(manifest, "books"))).toBeUndefined();
  });
});

describe("V7-M1-T04 (b): 付与表・メンバー表・グループ表を認識する", () => {
  test("宣言した表そのものは protected、指された3表はそれぞれの役割になる", () => {
    const manifest = manifestWith(DECLARATION);
    expect(accessControlTableRoles(manifest, "books")).toEqual(["protected"]);
    expect(accessControlTableRoles(manifest, "book_grant")).toEqual(["grant"]);
    expect(accessControlTableRoles(manifest, "member")).toEqual(["members"]);
    expect(accessControlTableRoles(manifest, "team")).toEqual(["groups"]);
  });

  test("薄い述語3本が同じ答えを返す", () => {
    const manifest = manifestWith(DECLARATION);
    expect(isGrantTable(manifest, "book_grant")).toBe(true);
    expect(isMemberTable(manifest, "member")).toBe(true);
    expect(isGroupTable(manifest, "team")).toBe(true);
    // 役割の取り違えが無いこと(付与表はメンバー表でもグループ表でもない)。
    expect(isMemberTable(manifest, "book_grant")).toBe(false);
    expect(isGroupTable(manifest, "book_grant")).toBe(false);
    expect(isGrantTable(manifest, "member")).toBe(false);
  });

  test("宣言していないアプリでは、どの表も役割を持たない", () => {
    const manifest = manifestWith(undefined);
    for (const tableId of ["books", "book_grant", "member", "team"]) {
      expect(accessControlTableRoles(manifest, tableId)).toEqual([]);
    }
  });

  test("enabled: false の宣言が指す表は、付与表として認識されない", () => {
    const manifest = manifestWith({ ...DECLARATION, enabled: false });
    expect(accessControlTableRoles(manifest, "book_grant")).toEqual([]);
    expect(isGrantTable(manifest, "book_grant")).toBe(false);
  });

  test("members / groups を書かない宣言では、その2つの役割は誰にも付かない", () => {
    const manifest = manifestWith({
      enabled: true,
      permissions: DECLARATION.permissions,
      creator_permission: "writer",
      grant: { table: "book_grant", target: "target", member: "member", permission: "permission" },
      members: { table: "member", account: "account" },
    });
    expect(accessControlTableRoles(manifest, "member")).toEqual(["members"]);
    expect(accessControlTableRoles(manifest, "team")).toEqual([]);
  });

  test("1つの表が複数の役割を兼ねるなら、全部を固定の順で返す", () => {
    // 付与表そのものにもアクセス権管理を宣言した(規約はこれを禁じていない)。
    const manifest = manifestWith(DECLARATION);
    const grantTable = tableOf(manifest, "book_grant");
    (grantTable as unknown as Record<string, unknown>).access_control = {
      ...DECLARATION,
      grant: { ...DECLARATION.grant, table: "book_grant" },
    };
    expect(accessControlTableRoles(manifest, "book_grant")).toEqual(["protected", "grant"]);
  });

  test("実在しない表IDを渡しても例外を投げず、空を返す", () => {
    const manifest = manifestWith(DECLARATION);
    expect(accessControlTableRoles(manifest, "nope")).toEqual([]);
    expect(isGrantTable(manifest, "nope")).toBe(false);
  });

  test("マニフェストの形が壊れていても例外を投げない(読取経路を 500 にしない)", () => {
    expect(accessControlTableRoles({} as unknown as Manifest, "books")).toEqual([]);
    expect(accessControlTableRoles(null as unknown as Manifest, "books")).toEqual([]);
  });
});

describe("V7-M1-T04 (c): 純粋関数である", () => {
  test("呼び出しても入力のマニフェストを1バイトも書き換えない", () => {
    const manifest = manifestWith(DECLARATION);
    const before = JSON.stringify(manifest);
    accessControlOf(tableOf(manifest, "books"));
    accessControlTableRoles(manifest, "books");
    isGrantTable(manifest, "book_grant");
    isMemberTable(manifest, "member");
    isGroupTable(manifest, "team");
    expect(JSON.stringify(manifest)).toBe(before);
  });
});
